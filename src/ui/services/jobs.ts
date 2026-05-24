import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getJobsDir, EFFORT_LEVELS } from "../../config";
import { resolveJobPath } from "../../jobs";

export interface QuickJobInput {
  time?: unknown;
  prompt?: unknown;
  recurring?: unknown;
  daily?: unknown;
}

export async function createQuickJob(input: QuickJobInput): Promise<{ name: string; schedule: string; recurring: boolean }> {
  const time = typeof input.time === "string" ? input.time.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const recurring = input.recurring == null
    ? (input.daily == null ? true : Boolean(input.daily))
    : Boolean(input.recurring);

  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Invalid time. Use HH:MM.");
  }
  if (!prompt) {
    throw new Error("Prompt is required.");
  }
  if (prompt.length > 10_000) {
    throw new Error("Prompt too long.");
  }

  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Time out of range.");
  }

  const schedule = `${minute} ${hour} * * *`;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const name = `quick-${stamp}-${hour.toString().padStart(2, "0")}${minute.toString().padStart(2, "0")}`;
  const path = join(getJobsDir(), `${name}.md`);
  const content = `---\nschedule: "${schedule}"\nrecurring: ${recurring ? "true" : "false"}\n---\n${prompt}\n`;

  await mkdir(getJobsDir(), { recursive: true });
  await writeFile(path, content, "utf-8");
  return { name, schedule, recurring };
}

export async function deleteJob(name: string): Promise<void> {
  const jobName = String(name || "").trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(jobName)) {
    throw new Error("Invalid job name.");
  }
  const path = join(getJobsDir(), `${jobName}.md`);
  await Bun.file(path).delete();
}

/** Validate one cron field against the grammar the scheduler (cron.ts) accepts: *, n, lo-hi, lists, /step. */
function validCronField(field: string, min: number, max: number): boolean {
  if (!field) return false;
  for (const part of field.split(",")) {
    if (part === "") return false;
    const segments = part.split("/");
    if (segments.length > 2) return false;
    const [range, stepStr] = segments;
    if (stepStr !== undefined) {
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step < 1) return false;
    }
    if (range === "*") continue;
    if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2) return false;
      const lo = Number(bounds[0]);
      const hi = Number(bounds[1]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
      if (lo < min || hi > max || lo > hi) return false;
      continue;
    }
    const n = Number(range);
    if (!Number.isInteger(n) || n < min || n > max) return false;
  }
  return true;
}

/** A standard 5-field cron expression (minute hour day-of-month month day-of-week). */
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return parts.every((field, i) => validCronField(field, ranges[i][0], ranges[i][1]));
}

/** Insert, replace, or (when value is null) remove a top-level frontmatter line, preserving order. */
function setFrontmatterLine(lines: string[], key: string, value: string | null): string[] {
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}:`));
  if (value === null) {
    return idx >= 0 ? lines.filter((_, i) => i !== idx) : lines;
  }
  const newLine = `${key}: ${value}`;
  if (idx >= 0) {
    const copy = lines.slice();
    copy[idx] = newLine;
    return copy;
  }
  return [...lines, newLine];
}

export interface JobFieldEdits {
  schedule?: string;
  /** "" clears the override (falls back to global default model). */
  model?: string;
  /** "" clears the override (falls back to auto). */
  effort?: string;
  prompt?: string;
}

/**
 * Update an existing job's editable fields in place. Only the provided fields are touched;
 * all other frontmatter lines and (unless prompt is given) the body are preserved verbatim.
 * Works for both flat jobs and agent-scoped "agent/label" jobs.
 */
export async function updateJobFields(name: string, edits: JobFieldEdits): Promise<void> {
  const jobName = String(name || "").trim();
  if (!/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/.test(jobName)) {
    throw new Error("Invalid job name.");
  }

  const path = resolveJobPath(jobName);
  let content: string;
  try {
    content = await Bun.file(path).text();
  } catch {
    throw new Error("Job not found.");
  }

  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) throw new Error("Job file has no frontmatter.");

  let fmLines = match[1].split("\n");
  let body = match[2];

  if (typeof edits.schedule === "string") {
    const schedule = edits.schedule.trim();
    if (!isValidCron(schedule)) {
      throw new Error('Invalid cron schedule. Use 5 fields, e.g. "0 22 * * *".');
    }
    fmLines = setFrontmatterLine(fmLines, "schedule", JSON.stringify(schedule));
  }

  if (typeof edits.model === "string") {
    const model = edits.model.trim();
    if (model && (model.length > 64 || !/^[a-zA-Z0-9._/-]+$/.test(model))) {
      throw new Error("Invalid model.");
    }
    fmLines = setFrontmatterLine(fmLines, "model", model || null);
  }

  if (typeof edits.effort === "string") {
    const effort = edits.effort.trim().toLowerCase();
    if (effort && !(EFFORT_LEVELS as string[]).includes(effort)) {
      throw new Error("Invalid effort.");
    }
    fmLines = setFrontmatterLine(fmLines, "effort", effort || null);
  }

  if (typeof edits.prompt === "string") {
    const prompt = edits.prompt.trim();
    if (!prompt) throw new Error("Prompt is required.");
    if (prompt.length > 10_000) throw new Error("Prompt too long.");
    body = prompt;
  }

  const next = `---\n${fmLines.join("\n")}\n---\n${body.trim()}\n`;
  await writeFile(path, next, "utf-8");
}
