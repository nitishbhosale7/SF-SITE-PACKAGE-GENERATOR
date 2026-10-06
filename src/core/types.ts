export interface Item {
  type: string;
  name: string;
  /** Ticked in the UI and written to package.xml by default. */
  checked: boolean;
  /** Why this component was included, most direct reason first. */
  reasons: string[];
  /** Found by scanning the site, or added by hand from the org. */
  origin: 'scan' | 'org';
}

/** A reference found by a scanner, already resolved to a real component in the org. */
export interface Ref {
  type: string;
  name: string;
  why: string;
  checked?: boolean;
}

export interface SiteSummary {
  id: string;
  name: string;
  urlPathPrefix: string;
  status: string;
}

export interface ResolveResult {
  site: SiteSummary;
  apiVersion: string;
  items: Item[];
  /** Things deliberately left out, e.g. the guest user profile. */
  excluded: string[];
  warnings: string[];
}

/** The scan's four phases, in order. `follow` loops until nothing new turns up. */
export type Stage = 'index' | 'core' | 'follow' | 'check';

export type Progress = (message: string, stage: Stage) => void;

/** Read-only view of what exists in the org, used by scanners to validate names. */
export interface Lookup {
  /** Case-insensitive match; returns the org's canonical fullName, or undefined. */
  find(type: string, name: string): string | undefined;
  /** Case-sensitive match. */
  exact(type: string, name: string): string | undefined;
  names(type: string): string[];
  /** The org's own namespace prefix, when it has one. */
  ownNamespace?: string;
}
