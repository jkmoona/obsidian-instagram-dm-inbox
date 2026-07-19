export interface InboxMessage {
  id: string;
  mid: string;
  sender_igsid: string;
  sender_username: string;
  timestamp_ms: number;
  text: string;
}

export interface TagStatus {
  name: string;
  code: string | null;
}

export interface Contact {
  sender_igsid: string;
  sender_username: string;
  status: string;
  updated_at: number;
}

export interface PluginSettings {
  serverUrl: string;
  apiKey: string;
  crmFolder: string;
  canvasFile: string;
  pollIntervalSeconds: number;
  statuses: TagStatus[];
  contactStatusCache: { [igsid: string]: string };
  migratedLegacyLayout: boolean;
}

export const DEFAULT_STATUSES: TagStatus[] = [
  { name: "new", code: null },
  { name: "pending", code: "!pending" },
  { name: "done", code: "!done" },
];

export const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "",
  apiKey: "",
  crmFolder: "CRM",
  canvasFile: "Inbox.canvas",
  pollIntervalSeconds: 5,
  statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
  contactStatusCache: {},
  migratedLegacyLayout: false,
};

export function defaultStatusName(statuses: TagStatus[]): string {
  const fallback = statuses.find((s) => s.code === null);
  return fallback?.name ?? statuses[0]?.name ?? "new";
}

export function statusFolderName(status: string): string {
  if (!status) return "New";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export interface CanvasNode {
  id: string;
  type: string;
  file?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
