import { describe, expect, it } from "vitest";
import { gradeStatus, normalizeCourseGrade, normalizeSubmission } from "../src/grades.js";
import fixtures from "./fixtures/submissions.json" with { type: "json" };

describe("submission grade status", () => {
  const byName = Object.fromEntries(fixtures.map((f: any) => [f.name, f]));
  const st = (n: string) => gradeStatus(byName[n].submission, byName[n].assignment).status;

  it("distinguishes zero from ungraded and missing", () => {
    expect(st("posted_zero")).toBe("zero");
    expect(st("missing_auto_zero")).toBe("zero");
    expect(st("missing_no_score")).toBe("not_submitted");
    expect(st("submitted_not_graded")).toBe("submitted_ungraded");
    expect(st("graded_full")).toBe("graded");
  });

  it("labels hidden, possibly hidden, excused, not graded, and unavailable", () => {
    expect(st("graded_unposted")).toBe("hidden");
    expect(st("manual_posting_unknown")).toBe("possibly_hidden");
    expect(st("excused")).toBe("excused");
    expect(st("not_graded_assignment")).toBe("not_graded_assignment");
    expect(gradeStatus(null).status).toBe("unavailable");
  });

  it("never invents a score and preserves Canvas values", () => {
    const n = normalizeSubmission(byName.graded_unposted.submission, byName.graded_unposted.assignment);
    expect(n.score).toBeNull();
    expect(n.grade).toBeNull();
    const z = normalizeSubmission(byName.posted_zero.submission, byName.posted_zero.assignment) as any;
    expect(z.score).toBe(0);
    expect(z.points_possible).toBe(10);
  });

  it("normalizes feedback, rubric and history in detail mode", () => {
    const d = normalizeSubmission(byName.graded_full.submission, byName.graded_full.assignment, { detail: true }) as any;
    expect(d.instructor_feedback[0].comment).toBe("Nice work");
    expect(d.instructor_feedback[0].attachments[0].file_id).toBe("9001");
    expect(d.rubric_assessment[0]).toMatchObject({ criterion: "Correctness", points: 8, rating: "Mostly correct" });
    expect(d.submission_history).toHaveLength(2);
    expect(d.submission_history[0].grade_status).toBe("submitted_ungraded");
  });
});

describe("course grade", () => {
  it("reports Canvas values including a real 0, and hidden vs not reported", () => {
    expect(normalizeCourseGrade({ enrollments: [{ type: "student", computed_current_score: 0, computed_current_grade: "F" }] }).status).toBe("reported");
    expect(normalizeCourseGrade({ enrollments: [{ type: "student", computed_current_score: 0 }] }).current_score).toBe(0);
    expect(normalizeCourseGrade({ hide_final_grades: true, enrollments: [{ type: "student" }] }).status).toBe("hidden_by_course");
    expect(normalizeCourseGrade({ enrollments: [{ type: "student" }] }).status).toBe("not_reported");
    expect(normalizeCourseGrade({ enrollments: [] }).status).toBe("no_student_enrollment");
  });
});
