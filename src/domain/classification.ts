import type { DataClassification } from './schemas';

const classificationRank = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
} as const satisfies Record<DataClassification, number>;

export function classificationAtMost(
  value: DataClassification,
  ceiling: DataClassification,
): boolean {
  return classificationRank[value] <= classificationRank[ceiling];
}
