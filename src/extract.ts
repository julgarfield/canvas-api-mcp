/**
 * Local, in-memory text extraction. Nothing is written to disk; nothing in
 * the document is executed or fetched.
 */
import { CanvasError } from "./errors.js";
import { htmlToText } from "./content.js";

export type ExtractKind = "pdf" | "docx" | "pptx" | "text" | "html";

const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "py", "java", "c", "h", "cpp", "hpp", "js", "ts", "r", "m", "sql", "tex", "rtf", "xml", "yaml", "yml", "ipynb", "log"]);

export function detectKind(filename: string | null, contentType: string | null): ExtractKind | null {
  const ct = (contentType ?? "").toLowerCase().split(";")[0].trim();
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ct === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx") return "docx";
  if (ct === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || ext === "pptx") return "pptx";
  if (ct === "text/html" || ext === "html" || ext === "htm") return "html";
  if (ct.startsWith("text/") || ct === "application/json" || ct === "application/xml" || TEXT_EXT.has(ext)) return "text";
  return null;
}

function decodeUtf8(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buf).replace(/\u0000/g, "");
}

export async function extractText(buf: Buffer, kind: ExtractKind): Promise<{ text: string; pages?: number; links?: { text: string; url: string; kind: string }[] }> {
  switch (kind) {
    case "text":
      return { text: decodeUtf8(buf) };
    case "html": {
      const r = htmlToText(decodeUtf8(buf));
      return { text: r.text, links: r.links };
    }
    case "pdf": {
      const { getDocumentProxy, extractText: pdfText } = await import("unpdf");
      try {
        const doc = await getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false } as never);
        const { totalPages, text } = await pdfText(doc, { mergePages: false });
        const pages = Array.isArray(text) ? text : [String(text)];
        return { text: pages.map((t, i) => `--- page ${i + 1} ---\n${t}`).join("\n\n"), pages: totalPages };
      } catch {
        throw new CanvasError("unsupported", "Could not extract text from this PDF (it may be scanned, encrypted, or malformed).");
      }
    }
    case "docx": {
      const mammoth = (await import("mammoth")).default;
      try {
        const r = await mammoth.extractRawText({ buffer: buf });
        return { text: r.value };
      } catch {
        throw new CanvasError("unsupported", "Could not extract text from this .docx file.");
      }
    }
    case "pptx": {
      const JSZip = (await import("jszip")).default;
      try {
        const zip = await JSZip.loadAsync(buf);
        const slides = Object.keys(zip.files)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
        if (slides.length > 1000) throw new Error("too many slides");
        const out: string[] = [];
        for (const [i, name] of slides.entries()) {
          const xml = await zip.files[name].async("string");
          const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
          const text = htmlToText(runs.join(" ")).text;
          out.push(`--- slide ${i + 1} ---\n${text}`);
        }
        return { text: out.join("\n\n"), pages: slides.length };
      } catch {
        throw new CanvasError("unsupported", "Could not extract text from this .pptx file.");
      }
    }
  }
}
