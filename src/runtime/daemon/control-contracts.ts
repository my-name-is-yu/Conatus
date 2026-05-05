import type { RuntimeControlOperationKind } from "../store/runtime-operation-schemas.js";

export interface DaemonRuntimeControlRequestBody {
  operationId: string;
  kind: RuntimeControlOperationKind;
  reason: string;
}
