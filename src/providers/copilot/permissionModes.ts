import type { ProviderPermissionModePolicy } from '../../core/providers/types';

export const COPILOT_PERMISSION_MODES = ['normal', 'acceptEdits', 'yolo'] as const;

export const COPILOT_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: COPILOT_PERMISSION_MODES,
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

/** YOLO turns on Copilot's session `allow_all` option, which also covers requests Claudian never sees. */
export function shouldAllowAllCopilotPermissions(permissionMode: string | undefined): boolean {
  return permissionMode === 'yolo';
}

/** Accept-edits is answered client-side: Copilot has no native mode for it. */
export function shouldAutoApproveCopilotEdits(permissionMode: string | undefined): boolean {
  return permissionMode === 'acceptEdits';
}
