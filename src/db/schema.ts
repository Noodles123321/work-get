import Dexie, { type EntityTable } from 'dexie';
import type { QuotaRecord } from '../shared/quota';
import type { Application, Job, MatchRecord, Resume } from '../shared/types';

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class WorkGetDB extends Dexie {
  jobs!: EntityTable<Job, 'id'>;
  applications!: EntityTable<Application, 'id'>;
  resumes!: EntityTable<Resume, 'id'>;
  matches!: EntityTable<MatchRecord, 'id'>;
  quotas!: EntityTable<QuotaRecord, 'id'>;
  kv!: EntityTable<MetaRecord, 'key'>;

  constructor(name = 'workget') {
    super(name);
    this.version(1).stores({
      jobs: 'id, platform, dedupeKey, familyKey, status, lastSeenAt, city, companyNorm, ruleScore',
      applications: 'id, jobId, platform, at, state, followUpAt',
      resumes: 'id, updatedAt',
      matches: 'id, jobId, resumeId',
      quotas: 'id, date, platform',
      kv: 'key',
    });
  }
}

export const db = new WorkGetDB();
