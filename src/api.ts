import { requestUrl, RequestUrlParam } from "obsidian";
import { Contact, InboxMessage, Funnel } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class IgCrmClient {
  private serverUrl: string;
  private apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
  }

  private get base(): string {
    return this.serverUrl.replace(/\/+$/, "");
  }

  async getMessages(limit = 50): Promise<InboxMessage[]> {
    const r = await this.request({
      url: `${this.base}/api/messages?limit=${limit}`,
      method: "GET",
    });
    if (!Array.isArray(r.json)) {
      throw new ApiError("Server returned non-array response (proxy or error page?)", r.status);
    }
    return r.json as InboxMessage[];
  }

  async ackMessages(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request({
      url: `${this.base}/api/messages/ack`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ ids }),
    });
  }

  async getContacts(): Promise<Contact[]> {
    const r = await this.request({
      url: `${this.base}/api/contacts`,
      method: "GET",
    });
    if (!Array.isArray(r.json)) {
      throw new ApiError("Server returned non-array response for /api/contacts", r.status);
    }
    return r.json as Contact[];
  }

  /** Read the tag config. Accepts either spelling: a server that has not been
   *  updated yet still answers with `statuses`. Drop the fallback in 0.3.0. */
  async getTagConfig(): Promise<Funnel[]> {
    const r = await this.request({
      url: `${this.base}/api/tag-config`,
      method: "GET",
    });
    const body = r.json as { funnels?: Funnel[]; statuses?: Funnel[] } | null;
    const funnels = body?.funnels ?? body?.statuses;
    if (!Array.isArray(funnels)) {
      throw new ApiError("Server returned malformed /api/tag-config response", r.status);
    }
    return funnels;
  }

  /** Send both spellings so an un-updated server still understands the write.
   *  Harmless on a current server, which prefers `funnels`. */
  async putTagConfig(funnels: Funnel[]): Promise<Funnel[]> {
    const r = await this.request({
      url: `${this.base}/api/tag-config`,
      method: "PUT",
      contentType: "application/json",
      body: JSON.stringify({ funnels, statuses: funnels }),
    });
    const body = r.json as { funnels?: Funnel[]; statuses?: Funnel[] } | null;
    const out = body?.funnels ?? body?.statuses;
    if (!Array.isArray(out)) {
      throw new ApiError("Server returned malformed /api/tag-config response", r.status);
    }
    return out;
  }

  /** Posts to the legacy `/status` route with both body keys.
   *
   *  Deliberately the old route, not `/funnel`: a plugin can update before its
   *  server does, and `/status` is the one that exists on both. The server maps
   *  either key to the same column, and 0.3.0 can switch the path once every
   *  deployment has the alias. */
  async setContactFunnel(igsid: string, funnel: string): Promise<void> {
    await this.request({
      url: `${this.base}/api/contacts/${encodeURIComponent(igsid)}/status`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ funnel, status: funnel }),
    });
  }

  private async request(params: RequestUrlParam) {
    const r = await requestUrl({
      ...params,
      headers: { ...(params.headers ?? {}), "X-Api-Key": this.apiKey },
      throw: false,
    });
    if (r.status >= 400) {
      throw new ApiError(`API ${r.status}: ${r.text}`, r.status);
    }
    return r;
  }
}
