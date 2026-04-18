import type Database from 'better-sqlite3';
import { seedApplication, type SeededApplicationStatus } from './seedApplication.js';

export interface SeedApplicationVarietyResult {
  applicationIds: number[];
  byStatus: Record<SeededApplicationStatus, number>;
}

interface VarietySpec {
  status: SeededApplicationStatus;
  characterName: string;
  userId: string;
  answerCount?: number;
}

const VARIETY: VarietySpec[] = [
  { status: 'in_progress', characterName: 'InProgressChar', userId: 'mock-applicant-inprogress', answerCount: 3 },
  { status: 'submitted',   characterName: 'SubmittedChar',  userId: 'mock-applicant-submitted' },
  { status: 'accepted',    characterName: 'AcceptedChar',   userId: 'mock-applicant-accepted' },
  { status: 'rejected',    characterName: 'RejectedChar',   userId: 'mock-applicant-rejected' },
  { status: 'abandoned',   characterName: 'AbandonedChar',  userId: 'mock-applicant-abandoned' },
];

/**
 * Seeds 5 applications — one per status (in_progress, submitted, accepted, rejected, abandoned).
 * Useful for testing /applications view_pending, accept/reject flows, and DM resume.
 */
export function seedApplicationVariety(db: Database.Database): SeedApplicationVarietyResult {
  const applicationIds: number[] = [];
  const byStatus = {
    in_progress: 0,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    abandoned: 0,
  } as Record<SeededApplicationStatus, number>;

  for (const spec of VARIETY) {
    const result = seedApplication(db, {
      characterName: spec.characterName,
      userId: spec.userId,
      status: spec.status,
      answerCount: spec.answerCount,
    });
    applicationIds.push(result.applicationId);
    byStatus[spec.status] += 1;
  }

  return { applicationIds, byStatus };
}
