import { parseArgs } from "node:util";
import type { StateManager } from "../../../base/state/state-manager.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";
import {
  loadRelationshipProfile,
  RelationshipProfileConsentScopeSchema,
  RelationshipProfileItemKindSchema,
  RelationshipProfileSensitivitySchema,
  RelationshipProfileSourceSchema,
  selectActiveRelationshipProfileItems,
  upsertRelationshipProfileItem,
  type RelationshipProfileConsentScope,
  type RelationshipProfileItemKind,
  type RelationshipProfileSensitivity,
  type RelationshipProfileSource,
} from "../../../platform/profile/relationship-profile.js";

function usage(): string {
  return `Usage:
  pulseed profile show [--scope <scope>] [--all] [--json]
  pulseed profile update --kind <kind> --key <stable_key> --value <value> [--scope <scope>] [--sensitivity <public|private|sensitive>] [--confidence <0-1>] [--source <source>] [--evidence-ref <ref>]

Scopes: local_planning, resident_behavior, memory_retrieval, user_facing_review
Kinds: identity_fact, preference, dislike, value, boundary, communication_style, notification_preference, long_term_goal, life_context, intervention_policy`;
}

function parseEnum<T extends string>(
  raw: string | undefined,
  label: string,
  parse: (value: string) => { success: true; data: T } | { success: false }
): T | null {
  if (raw === undefined) return null;
  const result = parse(raw);
  if (result.success) return result.data;
  getCliLogger().error(`Error: invalid ${label}: ${raw}`);
  return null;
}

function parseScopeList(raw: string[] | undefined): RelationshipProfileConsentScope[] | null {
  if (!raw || raw.length === 0) return null;
  const parsed: RelationshipProfileConsentScope[] = [];
  for (const value of raw) {
    const result = RelationshipProfileConsentScopeSchema.safeParse(value);
    if (!result.success) {
      getCliLogger().error(`Error: invalid scope: ${value}`);
      return null;
    }
    parsed.push(result.data);
  }
  return [...new Set(parsed)];
}

export async function cmdProfile(stateManager: StateManager, argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(usage());
    return 0;
  }

  if (subcommand === "show") {
    let values: { scope?: string; all?: boolean; json?: boolean };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          scope: { type: "string" },
          all: { type: "boolean" },
          json: { type: "boolean" },
        },
        strict: true,
      }) as { values: { scope?: string; all?: boolean; json?: boolean } });
    } catch (err) {
      getCliLogger().error(formatOperationError("parse profile show arguments", err));
      return 1;
    }

    const store = await loadRelationshipProfile(stateManager.getBaseDir());
    if (values.json) {
      console.log(JSON.stringify(store, null, 2));
      return 0;
    }

    let scope: RelationshipProfileConsentScope | null = null;
    if (values.scope !== undefined) {
      const parsed = RelationshipProfileConsentScopeSchema.safeParse(values.scope);
      if (!parsed.success) {
        getCliLogger().error(`Error: invalid scope: ${values.scope}`);
        return 1;
      }
      scope = parsed.data;
    }
    const items = values.all
      ? store.items
      : scope
        ? selectActiveRelationshipProfileItems(store, scope)
        : store.items.filter((item) => item.status === "active");

    if (items.length === 0) {
      console.log("No relationship profile items.");
      return 0;
    }

    console.log("Relationship profile:");
    for (const item of items) {
      console.log(
        `- ${item.stable_key} [${item.kind}] v${item.version} ${item.status}: ${item.value}` +
          ` (scopes=${item.allowed_scopes.join(",")}; sensitivity=${item.sensitivity}; confidence=${item.confidence.toFixed(2)})`
      );
    }
    return 0;
  }

  if (subcommand === "update") {
    let values: {
      kind?: string;
      key?: string;
      value?: string;
      scope?: string[];
      sensitivity?: string;
      confidence?: string;
      source?: string;
      "evidence-ref"?: string;
      note?: string;
      json?: boolean;
    };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          kind: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          scope: { type: "string", multiple: true },
          sensitivity: { type: "string" },
          confidence: { type: "string" },
          source: { type: "string" },
          "evidence-ref": { type: "string" },
          note: { type: "string" },
          json: { type: "boolean" },
        },
        strict: true,
      }) as {
        values: {
          kind?: string;
          key?: string;
          value?: string;
          scope?: string[];
          sensitivity?: string;
          confidence?: string;
          source?: string;
          "evidence-ref"?: string;
          note?: string;
          json?: boolean;
        };
      });
    } catch (err) {
      getCliLogger().error(formatOperationError("parse profile update arguments", err));
      return 1;
    }

    const kind = parseEnum<RelationshipProfileItemKind>(
      values.kind,
      "kind",
      (value) => RelationshipProfileItemKindSchema.safeParse(value) as never
    );
    const sensitivity = parseEnum<RelationshipProfileSensitivity>(
      values.sensitivity ?? "private",
      "sensitivity",
      (value) => RelationshipProfileSensitivitySchema.safeParse(value) as never
    );
    const source = parseEnum<RelationshipProfileSource>(
      values.source ?? "cli_update",
      "source",
      (value) => RelationshipProfileSourceSchema.safeParse(value) as never
    );
    const allowedScopes = parseScopeList(values.scope);
    if (!kind || !sensitivity || !source || values.scope && !allowedScopes) return 1;
    if (!values.key?.trim() || !values.value?.trim()) {
      getCliLogger().error("Error: --key and --value are required.");
      console.log(usage());
      return 1;
    }

    let confidence: number | undefined;
    if (values.confidence !== undefined) {
      confidence = Number(values.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        getCliLogger().error(`Error: --confidence must be a number between 0 and 1 (got: ${values.confidence})`);
        return 1;
      }
    }

    try {
      const result = await upsertRelationshipProfileItem(stateManager.getBaseDir(), {
        stableKey: values.key,
        kind,
        value: values.value,
        source,
        sensitivity,
        confidence,
        allowedScopes: allowedScopes ?? undefined,
        evidenceRef: values["evidence-ref"],
        note: values.note,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Updated relationship profile item ${result.item.stable_key} v${result.item.version}.`);
        if (result.superseded.length > 0) {
          console.log(`Superseded ${result.superseded.length} previous active item(s).`);
        }
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("update relationship profile", err));
      return 1;
    }
  }

  getCliLogger().error(`Unknown profile subcommand: "${subcommand}"`);
  console.log(usage());
  return 1;
}
