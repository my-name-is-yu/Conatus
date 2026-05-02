import { randomUUID } from "node:crypto";
import { SOIL_SCHEMA_SQL } from "./ddl.js";
import {
  SoilEmbeddingSchema,
  SoilMutationSchema,
  SoilPageMemberSchema,
  SoilCorrectionEntrySchema,
  type SoilMutationInput,
  type SoilPageMember,
  type SoilRecordOutcomeKind,
} from "./contracts.js";
import {
  encodeEmbedding,
  parseJsonArray,
  parseReindexRecordIds,
  serializeJson,
  type SqliteDatabase,
  unique,
} from "./sqlite-repository-helpers.js";

export function initializeSoilSqlite(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SOIL_SCHEMA_SQL);
  ensureSoilRecordUsageColumns(db);
}

export function initializeReadonlySoilSqlite(db: SqliteDatabase): void {
  db.pragma("query_only = ON");
}

function ensureSoilRecordUsageColumns(db: SqliteDatabase): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(soil_records)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  const additions = [
    ["last_used_at", "TEXT"],
    ["use_count", "INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0)"],
    ["validated_count", "INTEGER NOT NULL DEFAULT 0 CHECK (validated_count >= 0)"],
    ["negative_outcome_count", "INTEGER NOT NULL DEFAULT 0 CHECK (negative_outcome_count >= 0)"],
  ] as const;
  for (const [column, definition] of additions) {
    if (!columns.has(column)) {
      db.prepare(`ALTER TABLE soil_records ADD COLUMN ${column} ${definition}`).run();
    }
  }
}

export function applySoilMutation(db: SqliteDatabase, input: SoilMutationInput): void {
  const mutation = SoilMutationSchema.parse(input);
  const contentMutatedRecordIds = new Set<string>();
  const embeddedChunkIds = new Set<string>();
  const embeddedRecordIds = new Set<string>();

  const tx = db.transaction(() => {
    for (const record of mutation.records) {
      if (record.is_active) {
        db
          .prepare("UPDATE soil_records SET is_active = 0 WHERE record_key = ? AND record_id != ? AND is_active = 1")
          .run(record.record_key, record.record_id);
      }
      db.prepare(`
        INSERT INTO soil_records (
          record_id, record_key, version, record_type, soil_id, title, summary, canonical_text,
          goal_id, task_id, status, confidence, importance, source_reliability,
          valid_from, valid_to, supersedes_record_id, is_active, source_type, source_id,
          metadata_json, last_used_at, use_count, validated_count, negative_outcome_count,
          created_at, updated_at
        ) VALUES (
          @record_id, @record_key, @version, @record_type, @soil_id, @title, @summary, @canonical_text,
          @goal_id, @task_id, @status, @confidence, @importance, @source_reliability,
          @valid_from, @valid_to, @supersedes_record_id, @is_active, @source_type, @source_id,
          @metadata_json, @last_used_at, @use_count, @validated_count, @negative_outcome_count,
          @created_at, @updated_at
        )
        ON CONFLICT(record_id) DO UPDATE SET
          record_key = excluded.record_key,
          version = excluded.version,
          record_type = excluded.record_type,
          soil_id = excluded.soil_id,
          title = excluded.title,
          summary = excluded.summary,
          canonical_text = excluded.canonical_text,
          goal_id = excluded.goal_id,
          task_id = excluded.task_id,
          status = excluded.status,
          confidence = excluded.confidence,
          importance = excluded.importance,
          source_reliability = excluded.source_reliability,
          valid_from = excluded.valid_from,
          valid_to = excluded.valid_to,
          supersedes_record_id = excluded.supersedes_record_id,
          is_active = excluded.is_active,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          metadata_json = excluded.metadata_json,
          last_used_at = CASE
            WHEN soil_records.last_used_at IS NULL THEN excluded.last_used_at
            WHEN excluded.last_used_at IS NULL THEN soil_records.last_used_at
            WHEN excluded.last_used_at > soil_records.last_used_at THEN excluded.last_used_at
            ELSE soil_records.last_used_at
          END,
          use_count = MAX(soil_records.use_count, excluded.use_count),
          validated_count = MAX(soil_records.validated_count, excluded.validated_count),
          negative_outcome_count = MAX(soil_records.negative_outcome_count, excluded.negative_outcome_count),
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run({
        ...record,
        is_active: record.is_active ? 1 : 0,
        metadata_json: serializeJson(record.metadata_json),
        last_used_at: record.last_used_at,
        use_count: record.use_count,
        validated_count: record.validated_count,
        negative_outcome_count: record.negative_outcome_count,
      });
      contentMutatedRecordIds.add(record.record_id);
    }

    for (const chunk of mutation.chunks) {
      db.prepare(`
        INSERT INTO soil_chunks (
          chunk_id, record_id, soil_id, chunk_index, chunk_kind, heading_path_json,
          chunk_text, token_count, checksum, created_at
        ) VALUES (
          @chunk_id, @record_id, @soil_id, @chunk_index, @chunk_kind, @heading_path_json,
          @chunk_text, @token_count, @checksum, @created_at
        )
        ON CONFLICT(chunk_id) DO UPDATE SET
          record_id = excluded.record_id,
          soil_id = excluded.soil_id,
          chunk_index = excluded.chunk_index,
          chunk_kind = excluded.chunk_kind,
          heading_path_json = excluded.heading_path_json,
          chunk_text = excluded.chunk_text,
          token_count = excluded.token_count,
          checksum = excluded.checksum,
          created_at = excluded.created_at
      `).run({
        ...chunk,
        heading_path_json: serializeJson(chunk.heading_path_json),
      });
      contentMutatedRecordIds.add(chunk.record_id);
    }

    for (const page of mutation.pages) {
      db.prepare(`
        INSERT INTO soil_pages (
          page_id, soil_id, relative_path, route, kind, status, markdown, checksum, projected_at
        ) VALUES (
          @page_id, @soil_id, @relative_path, @route, @kind, @status, @markdown, @checksum, @projected_at
        )
        ON CONFLICT(page_id) DO UPDATE SET
          soil_id = excluded.soil_id,
          relative_path = excluded.relative_path,
          route = excluded.route,
          kind = excluded.kind,
          status = excluded.status,
          markdown = excluded.markdown,
          checksum = excluded.checksum,
          projected_at = excluded.projected_at
      `).run(page);
    }

    for (const member of mutation.page_members) {
      db.prepare(`
        INSERT INTO soil_page_members (page_id, record_id, ordinal, role, confidence)
        VALUES (@page_id, @record_id, @ordinal, @role, @confidence)
        ON CONFLICT(page_id, record_id, role) DO UPDATE SET
          ordinal = excluded.ordinal,
          confidence = excluded.confidence
      `).run(member);
    }

    for (const embedding of mutation.embeddings) {
      const parsed = SoilEmbeddingSchema.parse(embedding);
      db.prepare(`
        INSERT INTO soil_embeddings (
          chunk_id, model, embedding_version, encoding, embedding, embedded_at
        ) VALUES (
          @chunk_id, @model, @embedding_version, @encoding, @embedding, @embedded_at
        )
        ON CONFLICT(chunk_id, model, embedding_version) DO UPDATE SET
          encoding = excluded.encoding,
          embedding = excluded.embedding,
          embedded_at = excluded.embedded_at
      `).run({
        chunk_id: parsed.chunk_id,
        model: parsed.model,
        embedding_version: parsed.embedding_version,
        encoding: parsed.encoding,
        embedding: encodeEmbedding(parsed),
        embedded_at: parsed.embedded_at,
      });
      const chunk = db
        .prepare("SELECT record_id FROM soil_chunks WHERE chunk_id = ?")
        .get(parsed.chunk_id) as { record_id: string } | undefined;
      if (chunk) {
        embeddedChunkIds.add(parsed.chunk_id);
        embeddedRecordIds.add(chunk.record_id);
      }
    }

    for (const edge of mutation.edges) {
      db.prepare(`
        INSERT INTO soil_edges (src_record_id, edge_type, dst_record_id, confidence)
        VALUES (@src_record_id, @edge_type, @dst_record_id, @confidence)
        ON CONFLICT(src_record_id, edge_type, dst_record_id) DO UPDATE SET
          confidence = excluded.confidence
      `).run(edge);
    }

    for (const tombstone of mutation.tombstones) {
      db.prepare(`
        INSERT INTO soil_tombstones (tombstone_id, record_id, record_key, version, reason, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        tombstone.record_id,
        tombstone.record_key,
        tombstone.version,
        tombstone.reason,
        tombstone.deleted_at
      );
      if (tombstone.record_id) {
        db
          .prepare("UPDATE soil_records SET is_active = 0 WHERE record_id = ?")
          .run(tombstone.record_id);
        contentMutatedRecordIds.add(tombstone.record_id);
      }
      if (tombstone.record_key) {
        db
          .prepare("UPDATE soil_records SET is_active = 0 WHERE record_key = ?")
          .run(tombstone.record_key);
        const rows = db
          .prepare("SELECT record_id FROM soil_records WHERE record_key = ?")
          .all(tombstone.record_key) as Array<{ record_id: string }>;
        for (const row of rows) {
          contentMutatedRecordIds.add(row.record_id);
        }
      }
    }

    for (const correction of mutation.corrections) {
      const parsed = SoilCorrectionEntrySchema.parse(correction);
      db.prepare(`
        INSERT INTO soil_corrections (
          correction_id, target_ref_json, correction_kind, replacement_ref_json,
          actor, reason, created_at, provenance_json, audit_json
        ) VALUES (
          @correction_id, @target_ref_json, @correction_kind, @replacement_ref_json,
          @actor, @reason, @created_at, @provenance_json, @audit_json
        )
        ON CONFLICT(correction_id) DO UPDATE SET
          target_ref_json = excluded.target_ref_json,
          correction_kind = excluded.correction_kind,
          replacement_ref_json = excluded.replacement_ref_json,
          actor = excluded.actor,
          reason = excluded.reason,
          created_at = excluded.created_at,
          provenance_json = excluded.provenance_json,
          audit_json = excluded.audit_json
      `).run({
        correction_id: parsed.correction_id,
        target_ref_json: serializeJson(parsed.target_ref),
        correction_kind: parsed.correction_kind,
        replacement_ref_json: parsed.replacement_ref ? serializeJson(parsed.replacement_ref) : null,
        actor: parsed.actor,
        reason: parsed.reason,
        created_at: parsed.created_at,
        provenance_json: serializeJson(parsed.provenance),
        audit_json: serializeJson(parsed.audit),
      });
      if (parsed.audit.status !== "active") {
        continue;
      }
      db.prepare(`
        UPDATE soil_records
        SET status = ?, is_active = 0, updated_at = ?
        WHERE record_id = ?
      `).run(parsed.correction_kind, parsed.created_at, parsed.target_ref.id);
      contentMutatedRecordIds.add(parsed.target_ref.id);
      if (parsed.replacement_ref?.kind === "soil_record") {
        db.prepare(`
          UPDATE soil_records
          SET supersedes_record_id = COALESCE(supersedes_record_id, ?)
          WHERE record_id = ?
        `).run(parsed.target_ref.id, parsed.replacement_ref.id);
        contentMutatedRecordIds.add(parsed.replacement_ref.id);
      }
    }

    syncSoilFts(db, unique([...contentMutatedRecordIds]));
    const fullyEmbeddedRecordIds = new Set(
      unique([...embeddedRecordIds]).filter((recordId) => recordHasCompleteEmbeddingMutation(db, recordId, embeddedChunkIds))
    );
    completeOpenEmbeddingJobs(db, fullyEmbeddedRecordIds);
    if (contentMutatedRecordIds.size > 0) {
      const openEmbeddingRecordIds = new Set(loadOpenEmbeddingReindexRecordIds(db));
      const insertJob = db.prepare(`
        INSERT INTO soil_reindex_jobs (
          job_id, scope, reason, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const recordId of unique([...contentMutatedRecordIds]).filter((id) => !fullyEmbeddedRecordIds.has(id) && !openEmbeddingRecordIds.has(id))) {
        insertJob.run(
          randomUUID(),
          "embedding",
          "content mutation invalidated embeddings",
          "pending",
          JSON.stringify({ record_ids: [recordId] }),
          new Date().toISOString()
        );
      }
    }
  });

  tx();
}

export function recordSoilUsage(db: SqliteDatabase, recordIds: string[], usedAt: string): void {
  const ids = unique(recordIds);
  if (ids.length === 0) return;
  const tx = db.transaction(() => {
    for (const recordId of ids) {
      db.prepare(`
        UPDATE soil_records
        SET
          last_used_at = CASE
            WHEN last_used_at IS NULL OR ? > last_used_at THEN ?
            ELSE last_used_at
          END,
          use_count = use_count + 1
        WHERE record_id = ?
      `).run(usedAt, usedAt, recordId);
    }
  });
  tx();
}

export function recordSoilOutcome(
  db: SqliteDatabase,
  recordIds: string[],
  outcome: SoilRecordOutcomeKind,
  occurredAt: string
): void {
  const ids = unique(recordIds);
  if (ids.length === 0) return;
  const validatedIncrement = outcome === "validated" ? 1 : 0;
  const negativeIncrement = outcome === "negative" ? 1 : 0;
  const tx = db.transaction(() => {
    for (const recordId of ids) {
      db.prepare(`
        UPDATE soil_records
        SET
          validated_count = validated_count + ?,
          negative_outcome_count = negative_outcome_count + ?,
          updated_at = CASE
            WHEN ? > updated_at THEN ?
            ELSE updated_at
          END
        WHERE record_id = ?
      `).run(validatedIncrement, negativeIncrement, occurredAt, occurredAt, recordId);
    }
  });
  tx();
}

export function replaceSoilPageMembers(db: SqliteDatabase, pageId: string, members: SoilPageMember[]): void {
  const parsed = members.map((member) => SoilPageMemberSchema.parse({ ...member, page_id: pageId }));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM soil_page_members WHERE page_id = ?").run(pageId);
    for (const member of parsed) {
      db.prepare(`
        INSERT INTO soil_page_members (page_id, record_id, ordinal, role, confidence)
        VALUES (@page_id, @record_id, @ordinal, @role, @confidence)
      `).run(member);
    }
  });
  tx();
}

export function loadOpenEmbeddingReindexRecordIds(db: SqliteDatabase): string[] {
  const rows = db.prepare(`
    SELECT payload_json
    FROM soil_reindex_jobs
    WHERE scope = 'embedding'
      AND status IN ('pending', 'running')
  `).all() as Array<{ payload_json: string }>;
  const recordIds: string[] = [];
  for (const row of rows) {
    recordIds.push(...parseReindexRecordIds(row.payload_json));
  }
  return unique(recordIds);
}

function recordHasCompleteEmbeddingMutation(db: SqliteDatabase, recordId: string, embeddedChunkIds: Set<string>): boolean {
  const chunks = db
    .prepare("SELECT chunk_id FROM soil_chunks WHERE record_id = ?")
    .all(recordId) as Array<{ chunk_id: string }>;
  return chunks.length > 0 && chunks.every((chunk) => embeddedChunkIds.has(chunk.chunk_id));
}

function completeOpenEmbeddingJobs(db: SqliteDatabase, recordIds: Set<string>): void {
  if (recordIds.size === 0) return;
  const jobs = db.prepare(`
    SELECT job_id, payload_json
    FROM soil_reindex_jobs
    WHERE scope = 'embedding'
      AND status IN ('pending', 'running')
  `).all() as Array<{ job_id: string; payload_json: string }>;
  const complete = db.prepare("UPDATE soil_reindex_jobs SET status = 'completed', completed_at = ? WHERE job_id = ?");
  const completedAt = new Date().toISOString();
  for (const job of jobs) {
    const jobRecordIds = parseReindexRecordIds(job.payload_json);
    if (jobRecordIds.length > 0 && jobRecordIds.every((recordId) => recordIds.has(recordId))) {
      complete.run(completedAt, job.job_id);
    }
  }
}

function syncSoilFts(db: SqliteDatabase, recordIds: string[]): void {
  if (recordIds.length === 0) return;
  db.prepare(`DELETE FROM soil_chunk_fts WHERE record_id IN (${recordIds.map(() => "?").join(", ")})`).run(...recordIds);

  const rows = db.prepare(`
    SELECT
      sc.chunk_id,
      sc.record_id,
      sc.soil_id,
      (
        SELECT spm.page_id
        FROM soil_page_members spm
        WHERE spm.record_id = r.record_id
        ORDER BY CASE WHEN spm.role = 'primary' THEN 0 ELSE 1 END, spm.ordinal, spm.page_id
        LIMIT 1
      ) AS page_id,
      r.title AS title_context,
      COALESCE(r.summary, '') AS summary_context,
      sc.heading_path_json,
      sc.chunk_text
    FROM soil_chunks sc
    JOIN soil_records r ON r.record_id = sc.record_id
    WHERE sc.record_id IN (${recordIds.map(() => "?").join(", ")})
  `).all(...recordIds) as Array<{
    chunk_id: string;
    record_id: string;
    soil_id: string;
    page_id: string | null;
    title_context: string;
    summary_context: string;
    heading_path_json: string;
    chunk_text: string;
  }>;

  const insert = db.prepare(`
    INSERT INTO soil_chunk_fts (
      chunk_id, record_id, soil_id, page_id, title_context, summary_context, heading_context, chunk_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.chunk_id,
      row.record_id,
      row.soil_id,
      row.page_id,
      row.title_context,
      row.summary_context,
      parseJsonArray(row.heading_path_json).join(" / "),
      row.chunk_text
    );
  }
}
