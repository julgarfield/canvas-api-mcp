import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/content.js";
import { detectKind, extractText } from "../src/extract.js";

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function minimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("text extraction", () => {
  it("detects kinds by content type or extension", () => {
    expect(detectKind("a.pdf", null)).toBe("pdf");
    expect(detectKind("x", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(detectKind("slides.pptx", null)).toBe("pptx");
    expect(detectKind("main.py", "application/octet-stream")).toBe("text");
    expect(detectKind("movie.mp4", "video/mp4")).toBeNull();
  });

  it("extracts PDF text", async () => {
    const r = await extractText(minimalPdf("Synthetic syllabus PDF"), "pdf");
    expect(r.text).toContain("Synthetic syllabus PDF");
    expect(r.pages).toBe(1);
  });

  it("extracts DOCX text", async () => {
    const r = await extractText(await minimalDocx("Synthetic rubric doc"), "docx");
    expect(r.text).toContain("Synthetic rubric doc");
  });

  it("extracts PPTX slide text", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", "<p:sld><a:t>Second</a:t></p:sld>");
    zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>First &amp; foremost</a:t></p:sld>");
    const r = await extractText(await zip.generateAsync({ type: "nodebuffer" }), "pptx");
    expect(r.text.indexOf("First & foremost")).toBeLessThan(r.text.indexOf("Second"));
  });

  it("fails cleanly on corrupt input", async () => {
    await expect(extractText(Buffer.from("not a pdf"), "pdf")).rejects.toThrow(/Could not extract/);
  });
});

describe("html handling", () => {
  it("drops scripts/styles, lists links and embeds, scrubs verifiers", () => {
    const { text, links } = htmlToText(
      `<style>x{}</style><p>Hi&nbsp;there</p><script>fetch('https://evil')</script><a href="https://c.example.edu/files/1/download?verifier=S3CRET">file</a><img src="https://img.example/x.png">`,
    );
    expect(text).toContain("Hi there");
    expect(text).not.toContain("fetch");
    expect(links[0].url).toBe("https://c.example.edu/files/1/download");
    expect(links[1]).toMatchObject({ kind: "embed", url: "https://img.example/x.png" });
  });
});
