import { z } from 'zod';

/**
 * One item to sort. The id is the caller's own handle for the item and is never sent to a seat,
 * so it is checked for shape only; the text is what a seat reads, and it is quoted as untrusted
 * data when the prompt is built.
 */
export const TriageItemSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
});
export type TriageItem = z.infer<typeof TriageItemSchema>;

/** A batch is bounded so one runaway file cannot dial a provider once a line for ever. */
export const MAX_TRIAGE_BATCH = 500;

export const TriageBatchSchema = z
  .array(TriageItemSchema)
  .min(1, 'a batch must contain at least one item')
  .max(MAX_TRIAGE_BATCH, `a batch is at most ${MAX_TRIAGE_BATCH} items`)
  .superRefine((items, context) => {
    // Ids key the output, the record and the caller's own pipeline, so a repeat would make one
    // item's route unreadable rather than merely untidy.
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate item id: ${item.id}`,
        });
      }
      seen.add(item.id);
    }
  });

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
    )
    .join('; ');
}

export function parseTriageBatch(raw: string, source: string): TriageItem[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid triage batch in ${source}: the file is not valid JSON.`);
  }
  const parsed = TriageBatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid triage batch in ${source}: ${describeIssues(parsed.error)}. Expected a JSON array of { "id": string, "text": string } with unique ids.`,
    );
  }
  return parsed.data;
}

export async function readTriageBatch(path: string): Promise<TriageItem[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Triage batch file not found: ${path}`);
  return parseTriageBatch(await file.text(), path);
}
