import { requestUrl, RequestUrlParam } from "obsidian";
import { Contact, InboxMessage, TagStatus } from "./types";

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

  async getTagConfig(): Promise<TagStatus[]> {
    const r = await this.request({
      url: `${this.base}/api/tag-config`,
      method: "GET",
    });
    const statuses = (r.json as { statuses?: TagStatus[] })?.statuses;
    if (!Array.isArray(statuses)) {
      throw new ApiError("Server returned malformed /api/tag-config response", r.status);
    }
    return statuses;
  }

  async putTagConfig(statuses: TagStatus[]): Promise<TagStatus[]> {
    const r = await this.request({
      url: `${this.base}/api/tag-config`,
      method: "PUT",
      contentType: "application/json",
      body: JSON.stringify({ statuses }),
    });
    const out = (r.json as { statuses?: TagStatus[] })?.statuses;
    if (!Array.isArray(out)) {
      throw new ApiError("Server returned malformed /api/tag-config response", r.status);
    }
    return out;
  }

  async setContactStatus(igsid: string, status: string): Promise<void> {
    await this.request({
      url: `${this.base}/api/contacts/${encodeURIComponent(igsid)}/status`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ status }),
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
