/**
 * Normalization of Canvas grade data. This module NEVER computes a
 * replacement grade: it reports Canvas' own values and labels what kind of
 * "no number" a null represents, when Canvas provides enough to tell.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = Record<string, any>;

export type SubmissionGradeStatus =
  | "graded" // Canvas reports a non-zero score or a grade
  | "zero" // Canvas reports a score of exactly 0 (distinct from ungraded)
  | "excused"
  | "hidden" // graded but not yet posted/released to you
  | "possibly_hidden" // manual posting policy and no posted score; can't tell hidden vs. ungraded
  | "submitted_ungraded"
  | "not_submitted"
  | "not_graded_assignment" // assignment grading_type is not_graded
  | "unavailable"; // Canvas returned no submission data

export function gradeStatus(sub: Any | null | undefined, assignment?: Any | null): { status: SubmissionGradeStatus; basis: string } {
  if (!sub || typeof sub !== "object") return { status: "unavailable", basis: "Canvas returned no submission for this assignment." };
  if (sub.excused === true) return { status: "excused", basis: "submission.excused is true." };
  const hasScore = typeof sub.score === "number";
  const hasGrade = sub.grade !== null && sub.grade !== undefined && sub.grade !== "";
  if (hasScore && sub.score === 0) return { status: "zero", basis: "Canvas reports score = 0." };
  if (hasScore || hasGrade) return { status: "graded", basis: "Canvas reports a posted score/grade." };
  if (assignment?.grading_type === "not_graded") return { status: "not_graded_assignment", basis: "assignment.grading_type is not_graded." };
  const ws = sub.workflow_state;
  const posted = sub.posted_at !== null && sub.posted_at !== undefined;
  if (!posted && (ws === "graded" || (sub.graded_at !== null && sub.graded_at !== undefined))) {
    return { status: "hidden", basis: "Submission is graded but posted_at is null (not released to students)." };
  }
  if (!posted && assignment?.post_manually === true && ws !== "unsubmitted") {
    return { status: "possibly_hidden", basis: "Assignment uses manual grade posting and no score is posted; Canvas does not say whether it is graded." };
  }
  if (ws === "submitted" || ws === "pending_review") return { status: "submitted_ungraded", basis: `workflow_state is ${ws} with no score.` };
  if (ws === "unsubmitted") return { status: "not_submitted", basis: "workflow_state is unsubmitted with no score." };
  return { status: "submitted_ungraded", basis: `No score reported (workflow_state: ${String(ws ?? "unknown")}).` };
}

function attachmentMeta(a: Any) {
  return {
    file_id: a?.id != null ? String(a.id) : null,
    display_name: a?.display_name ?? a?.filename ?? null,
    content_type: a?.["content-type"] ?? a?.content_type ?? null,
    size: a?.size ?? null,
    created_at: a?.created_at ?? null,
    note: "Use canvas_get_file_text with this file_id to extract text on demand.",
  };
}

export function normalizeSubmission(sub: Any | null | undefined, assignment?: Any | null, opts: { detail?: boolean } = {}) {
  const { status, basis } = gradeStatus(sub, assignment);
  if (!sub) return { grade_status: status, grade_status_basis: basis };
  const out: Any = {
    grade_status: status,
    grade_status_basis: basis,
    score: sub.score ?? null,
    grade: sub.grade ?? null,
    entered_score: sub.entered_score ?? null,
    entered_grade: sub.entered_grade ?? null,
    points_possible: assignment?.points_possible ?? null,
    workflow_state: sub.workflow_state ?? null,
    submitted_at: sub.submitted_at ?? null,
    graded_at: sub.graded_at ?? null,
    posted_at: sub.posted_at ?? null,
    late: sub.late ?? null,
    missing: sub.missing ?? null,
    excused: sub.excused ?? null,
    late_policy_status: sub.late_policy_status ?? null,
    points_deducted: sub.points_deducted ?? null,
    seconds_late: sub.seconds_late ?? null,
    attempt: sub.attempt ?? null,
    allowed_attempts: assignment?.allowed_attempts ?? null,
    submission_type: sub.submission_type ?? null,
    grade_matches_current_submission: sub.grade_matches_current_submission ?? null,
    redo_request: sub.redo_request ?? null,
  };
  if (opts.detail) {
    if (Array.isArray(sub.attachments)) out.submitted_attachments = sub.attachments.map(attachmentMeta);
    if (typeof sub.url === "string") out.submitted_url = sub.url;
    if (typeof sub.body === "string") out.submitted_body_html = sub.body;
    out.instructor_feedback = Array.isArray(sub.submission_comments)
      ? sub.submission_comments.map((c: Any) => ({
          author_name: c?.author_name ?? c?.author?.display_name ?? null,
          created_at: c?.created_at ?? null,
          edited_at: c?.edited_at ?? null,
          attempt: c?.attempt ?? null,
          comment: c?.comment ?? "",
          attachments: Array.isArray(c?.attachments) ? c.attachments.map(attachmentMeta) : [],
          media_comment: c?.media_comment
            ? { media_type: c.media_comment.media_type ?? null, display_name: c.media_comment.display_name ?? null, note: "Media comments are viewable in Canvas; not transcribed." }
            : null,
        }))
      : null;
    out.rubric_assessment = normalizeRubric(sub.rubric_assessment, assignment?.rubric);
    out.submission_history = Array.isArray(sub.submission_history)
      ? sub.submission_history.map((h: Any) => ({
          attempt: h?.attempt ?? null,
          submitted_at: h?.submitted_at ?? null,
          graded_at: h?.graded_at ?? null,
          posted_at: h?.posted_at ?? null,
          workflow_state: h?.workflow_state ?? null,
          score: h?.score ?? null,
          grade: h?.grade ?? null,
          late: h?.late ?? null,
          missing: h?.missing ?? null,
          submission_type: h?.submission_type ?? null,
          attachments: Array.isArray(h?.attachments) ? h.attachments.map(attachmentMeta) : [],
          grade_status: gradeStatus(h, assignment).status,
        }))
      : null;
  }
  return out;
}

export function normalizeRubric(assessment: Any | null | undefined, rubric: Any[] | null | undefined) {
  if (!assessment || typeof assessment !== "object") return null;
  const byId = new Map<string, Any>();
  if (Array.isArray(rubric)) for (const c of rubric) if (c?.id != null) byId.set(String(c.id), c);
  return Object.entries(assessment).map(([criterionId, v]: [string, Any]) => {
    const crit = byId.get(criterionId);
    const rating = Array.isArray(crit?.ratings) ? crit.ratings.find((r: Any) => r?.id != null && String(r.id) === String(v?.rating_id)) : null;
    return {
      criterion_id: criterionId,
      criterion: crit?.description ?? null,
      criterion_points_possible: crit?.points ?? null,
      points: v?.points ?? null,
      rating: rating?.description ?? null,
      comments: v?.comments ?? null,
    };
  });
}

export function normalizeAssignment(a: Any, courseName?: string | null) {
  return {
    id: a?.id != null ? String(a.id) : null,
    name: a?.name ?? null,
    course_id: a?.course_id != null ? String(a.course_id) : null,
    course_name: courseName ?? null,
    due_at: a?.due_at ?? null,
    lock_at: a?.lock_at ?? null,
    unlock_at: a?.unlock_at ?? null,
    points_possible: a?.points_possible ?? null,
    grading_type: a?.grading_type ?? null,
    assignment_group_id: a?.assignment_group_id != null ? String(a.assignment_group_id) : null,
    submission_types: a?.submission_types ?? null,
    allowed_attempts: a?.allowed_attempts ?? null,
    omit_from_final_grade: a?.omit_from_final_grade ?? null,
    post_manually: a?.post_manually ?? null,
    is_quiz: a?.is_quiz_assignment ?? Boolean(a?.quiz_id),
    is_new_quiz: a?.is_quiz_lti_assignment ?? null,
    external_tool_url: a?.external_tool_tag_attributes?.url ?? null,
    html_url: a?.html_url ?? null,
    locked_for_user: a?.locked_for_user ?? null,
    lock_explanation: a?.lock_explanation ?? null,
  };
}

/**
 * Course-level score from the student's enrollment as reported by Canvas.
 * Canvas' definitions: "current" counts only graded work; "final" treats
 * ungraded work as zero. We do not recompute either.
 */
export function normalizeCourseGrade(course: Any) {
  const enr: Any | undefined = Array.isArray(course?.enrollments)
    ? course.enrollments.find((e: Any) => e?.type === "student" || e?.type === "StudentEnrollment") ?? course.enrollments[0]
    : undefined;
  const hidden = course?.hide_final_grades === true;
  const g = {
    current_score: enr?.computed_current_score ?? null,
    current_grade: enr?.computed_current_grade ?? null,
    final_score: enr?.computed_final_score ?? null,
    final_grade: enr?.computed_final_grade ?? null,
    current_points: enr?.computed_current_points ?? null,
  };
  const anyReported = [g.current_score, g.current_grade, g.final_score, g.final_grade].some((v) => v !== null && v !== undefined);
  let status: "reported" | "hidden_by_course" | "not_reported" | "no_student_enrollment";
  if (!enr) status = "no_student_enrollment";
  else if (anyReported) status = "reported";
  else if (hidden) status = "hidden_by_course";
  else status = "not_reported";
  const period =
    enr && enr.has_grading_periods
      ? {
          current_grading_period_title: enr.current_grading_period_title ?? null,
          current_grading_period_id: enr.current_grading_period_id != null ? String(enr.current_grading_period_id) : null,
          current_period_current_score: enr.current_period_computed_current_score ?? null,
          current_period_current_grade: enr.current_period_computed_current_grade ?? null,
          current_period_final_score: enr.current_period_computed_final_score ?? null,
          current_period_final_grade: enr.current_period_computed_final_grade ?? null,
          totals_for_all_grading_periods_option: enr.totals_for_all_grading_periods_option ?? null,
        }
      : null;
  return {
    status,
    ...g,
    enrollment_state: enr?.enrollment_state ?? null,
    hide_final_grades: course?.hide_final_grades ?? null,
    grading_period: period,
  };
}

export const SCORE_DEFINITIONS =
  "Scores are exactly as Canvas reports them. current_* counts only graded work; final_* treats ungraded work as zero. " +
  "Nothing is recalculated. status=hidden_by_course means the instructor hid totals; not_reported means Canvas returned no totals.";
