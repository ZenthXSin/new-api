import type { CloudEnvironment, CloudEnvironmentCapabilities, CloudEnvironmentConfig } from '../cloud-types'

export const cloudConfig: CloudEnvironmentConfig = {
  repositories: [{ url: 'https://github.com/example/portal.git', branch: 'main', path: 'portal' }],
  installScript: '',
  startSkill: '',
  internetAccess: 'enabled',
  allowedDomains: [],
  environmentVariables: [],
  privacy: 'private',
  advanced: { setupTimeoutSeconds: 600 },
}

export const cloudEnvironment: CloudEnvironment = {
  id: 'environment-1',
  name: 'Developer portal',
  description: 'Portal tools',
  createdAt: 1,
  updatedAt: 2,
  setupWorkspaceId: '',
  draftRevision: 1,
  preparedRevision: null,
  publishedVersion: null,
  publishedAt: null,
  status: 'draft',
  lastError: null,
  config: cloudConfig,
  published: null,
}

export const cloudCapabilities: CloudEnvironmentCapabilities = {
  runtime: 'docker',
  internetModes: ['enabled'],
  networkSecrets: false,
  sharingModes: ['private'],
  snapshotScope: 'project_and_user_tools',
  systemPackageInstall: false,
  limits: { maxRepositories: 10, maxEnvironmentVariables: 128 },
  unsupportedReasons: {
    internetAccess: 'Per-environment network restrictions are unavailable.',
    networkSecrets: 'Host-scoped network secret injection is unavailable.',
    sharing: 'Environment sharing is unavailable.',
    systemPackageInstall: 'Install tools into the environment home or project.',
  },
}
