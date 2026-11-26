import {
  buildPermissionModeOptions,
  createPermissionModePolicy,
  type ProviderPermissionModeDefinition,
} from '../../core/providers/permissionModes';
import type { ProviderPermissionModeOption } from '../../core/providers/types';

const COPILOT_PERMISSION_MODES: readonly ProviderPermissionModeDefinition[] = Object.freeze([
  { value: 'normal', label: 'Ask', description: { key: 'chat.permissionMode.copilot.askDesc' } },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: { key: 'chat.permissionMode.copilot.acceptEditsDesc' },
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description: { key: 'chat.permissionMode.copilot.yoloDesc' },
    bypassesApprovals: true,
  },
]);

export const COPILOT_PERMISSION_MODE_POLICY = createPermissionModePolicy(COPILOT_PERMISSION_MODES, {
  fallbackValue: 'normal',
  defaultValue: 'normal',
});

export function getCopilotPermissionModeOptions(): ProviderPermissionModeOption[] {
  return buildPermissionModeOptions(COPILOT_PERMISSION_MODES);
}

/** YOLO turns on Copilot's session `allow_all` option, which also covers requests Claudian never sees. */
export function shouldAllowAllCopilotPermissions(permissionMode: string | undefined): boolean {
  return permissionMode === 'yolo';
}

/** Accept-edits is answered client-side: Copilot has no native mode for it. */
export function shouldAutoApproveCopilotEdits(permissionMode: string | undefined): boolean {
  return permissionMode === 'acceptEdits';
}
