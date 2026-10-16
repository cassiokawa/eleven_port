import Dexie, { type Table } from "dexie";
import type { AudioEntry, BlobEntry, Collection, Item, Job, Part, Unit } from "./types";

export class LibraryDB extends Dexie {
  items!: Table<Item, string>;
  parts!: Table<Part, string>;
  jobs!: Table<Job, string>;
  units!: Table<Unit, string>;
  blobs!: Table<BlobEntry, string>;
  audio!: Table<AudioEntry, string>;
  collections!: Table<Collection, string>;

  constructor(name = "eleven-port") {
    super(name);
    this.version(1).stores({
      items: "id, kind, status, collection, capturedAt, *tags",
      parts: "id, itemId, [itemId+index]",
      jobs: "id, itemId, state",
      units: "id, jobId, [jobId+index], [jobId+status]",
    });
    this.version(2).stores({
      blobs: "id",
      audio: "key, createdAt",
      collections: "path",
    });
  }
}
