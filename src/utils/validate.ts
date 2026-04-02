import type { Priority, EventCategory, EventSeverity, ApprovalCategory } from '../types/index.js';
import { VALID_PRIORITIES } from '../types/index.js';

const AGENT_NAME_REGEX = /^[a-z0-9_-]+$/;

export function validateAgentName(name: string): void {
  if (!name || !AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid agent name '${name}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validateOrgName(org: string): void {
  if (!org || !AGENT_NAME_REGEX.test(org)) {
    throw new Error(
      `Invalid org name '${org}'. Must contain only lowercase letters, numbers, underscores, and hyphens.`
    );
  }
}

export function validatePriority(priority: string): asserts priority is Priority {
  if (!VALID_PRIORITIES.includes(priority as Priority)) {
    throw new Error(
      `Invalid priority '${priority}'. Must be one of: ${VALID_PRIORITIES.join(', ')}`
    );
  }
}

const VALID_CATEGORIES: EventCategory[] = [
  'action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval',
];

export function validateEventCategory(category: string): asserts category is EventCategory {
  if (!VALID_CATEGORIES.includes(category as EventCategory)) {
    throw new Error(
      `Invalid event category '${category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`
    );
  }
}

const VALID_SEVERITIES: EventSeverity[] = ['info', 'warning', 'error', 'critical'];

export function validateEventSeverity(severity: string): asserts severity is EventSeverity {
  if (!VALID_SEVERITIES.includes(severity as EventSeverity)) {
    throw new Error(
      `Invalid severity '${severity}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`
    );
  }
}

const VALID_APPROVAL_CATEGORIES: ApprovalCategory[] = [
  'external-comms', 'financial', 'deployment', 'data-deletion', 'other',
];

export function validateApprovalCategory(category: string): asserts category is ApprovalCategory {
  if (!VALID_APPROVAL_CATEGORIES.includes(category as ApprovalCategory)) {
    throw new Error(
      `Invalid approval category '${category}'. Must be one of: ${VALID_APPROVAL_CATEGORIES.join(', ')}`
    );
  }
}

export function validateModel(model: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error(`Invalid model name '${model}'. Must be alphanumeric with dots and hyphens.`);
  }
}

export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}
