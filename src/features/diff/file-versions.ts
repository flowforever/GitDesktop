/** Exact versions supplied by a caller that verified the displayed file bytes. */
export interface DiffFileVersion {
  path: string | null;
  revision: string;
}

export interface DiffFileVersions {
  before: DiffFileVersion | null;
  after: DiffFileVersion | null;
}
