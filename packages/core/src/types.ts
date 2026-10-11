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
