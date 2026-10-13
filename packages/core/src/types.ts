export type BlockType = "heading" | "paragraph" | "list" | "code" | "quote" | "image";

export interface Block {
  type: BlockType;
  text: string;
  level?: number;
}

export type DocStatus = "partial" | "complete";
export type ItemKind = "article" | "book" | "pdf" | "note";

export interface Part {
  id: string;
  itemId: string;
  index: number;
  title: string;
  blocks: Block[];
  hash: string;
  status: "ok" | "failed" | "pending";
}

export interface Item {
  id: string;
  kind: ItemKind;
  title: string;
  author?: string;
  source: string;
  capturedAt: number;
  status: DocStatus;
  tags: string[];
  collection?: string;
  /** Last narration position, so playback resumes where it stopped. */
  position?: { part: number; chunk: number };
}

export type JobState =
  | "queued"
  | "capturing"
  | "ocr"
  | "assembling"
  | "done"
  | "failed"
  | "paused";

export interface Job {
  id: string;
  itemId: string;
  state: JobState;
  total?: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export type UnitStatus = "pending" | "done" | "failed";

export interface Unit {
  id: string; // `${jobId}:${index}`
  jobId: string;
  index: number;
  status: UnitStatus;
  attempts: number;
  hash?: string;
  payload?: string;
  error?: string;
}

/** Original source bytes (e.g. the PDF) kept so failed parts can be reprocessed later. */
export interface BlobEntry {
  id: string; // itemId
  data: Uint8Array;
  type: string;
}

/** Cached narration audio keyed by voice + chunk content hash. */
export interface AudioEntry {
  key: string;
  data: Blob;
  createdAt: number;
}

/** Folder in the collection tree; path like "Science/Physics". */
export interface Collection {
  path: string;
}
