import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { COPILOT_PROVIDER_ICON } from '../../../shared/icons';
import { copilotModelPolicy } from '../CopilotModelPolicy';
import { getCopilotPermissionModeOptions } from '../permissionModes';

export const copilotChatUIConfig: ProviderChatUIConfig = {
  ...copilotModelPolicy,
  getPermissionModeOptions: getCopilotPermissionModeOptions,
  getProviderIcon() {
    return COPILOT_PROVIDER_ICON;
  },
};
