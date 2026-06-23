export type PendingDesktopMaterialization = {
  priorSessionId: string;
  targetSessionId: string;
  reusingLiveSdkSession: boolean;
  snapshotKind: string;
};

let allowLazySessionMaterialization = true;
let pendingDesktopMaterialization: PendingDesktopMaterialization | null = null;

export function isLazySessionMaterializationAllowed(): boolean {
  return allowLazySessionMaterialization;
}

export function setLazySessionMaterializationAllowed(allowed: boolean): void {
  allowLazySessionMaterialization = allowed;
}

export function getPendingDesktopMaterialization(): PendingDesktopMaterialization | null {
  return pendingDesktopMaterialization;
}

export function setPendingDesktopMaterialization(value: PendingDesktopMaterialization | null): void {
  pendingDesktopMaterialization = value;
}

export function clearPendingDesktopMaterialization(): void {
  pendingDesktopMaterialization = null;
}

export function resetSessionMaterializationState(options?: {
  allowLazySessionMaterialization?: boolean;
}): void {
  allowLazySessionMaterialization = options?.allowLazySessionMaterialization ?? true;
  pendingDesktopMaterialization = null;
}
