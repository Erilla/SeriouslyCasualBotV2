/**
 * Calculate review dates from a start date.
 */
export function calculateReviewDates(startDate: string): {
  twoWeek: Date;
  fourWeek: Date;
  sixWeek: Date;
} {
  const start = new Date(startDate + 'T00:00:00Z');
  const twoWeek = new Date(start);
  twoWeek.setUTCDate(twoWeek.getUTCDate() + 14);
  const fourWeek = new Date(start);
  fourWeek.setUTCDate(fourWeek.getUTCDate() + 28);
  const sixWeek = new Date(start);
  sixWeek.setUTCDate(sixWeek.getUTCDate() + 42);
  return { twoWeek, fourWeek, sixWeek };
}
