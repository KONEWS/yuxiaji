import { env } from "cloudflare:workers";

export type BookProviderName = "google_books" | "open_library" | "ndl";
export type BookCatalogItem = {
  provider: BookProviderName;
  id: string;
  title: string;
  originalTitle: string;
  authors: string[];
  description: string;
  image: string;
  year?: number;
  pageCount?: number;
  publisher?: string;
  subjects: string[];
  isbn10?: string;
  isbn13?: string;
};
export type BookRequestOptions = { signal?: AbortSignal };

export class BooksApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "BooksApiError"; }
}

function year(value: unknown) {
  const match = String(value ?? "").match(/(?:18|19|20|21)\d{2}/);
  return match ? Number(match[0]) : undefined;
}

function isbns(values: unknown) {
  const list = Array.isArray(values) ? values.map(String) : [];
  return { isbn10: list.find((value) => /^\d{9}[\dX]$/i.test(value)), isbn13: list.find((value) => /^\d{13}$/.test(value)) };
}

function googleItem(item: { id?: string; volumeInfo?: Record<string, unknown> }): BookCatalogItem | null {
  const info = item.volumeInfo || {};
  const id = String(item.id || "").trim();
  const title = String(info.title || "").trim();
  if (!id || !title) return null;
  const identifiers = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers as Array<{ type?: string; identifier?: string }> : [];
  const isbn10 = identifiers.find((candidate) => candidate.type === "ISBN_10")?.identifier;
  const isbn13 = identifiers.find((candidate) => candidate.type === "ISBN_13")?.identifier;
  const images = info.imageLinks && typeof info.imageLinks === "object" ? info.imageLinks as Record<string, unknown> : {};
  return { provider: "google_books", id, title, originalTitle: title, authors: Array.isArray(info.authors) ? info.authors.map(String).slice(0, 20) : [], description: String(info.description || ""), image: String(images.extraLarge || images.large || images.medium || images.thumbnail || "").replace(/^http:/, "https:"), year: year(info.publishedDate), pageCount: Number(info.pageCount) || undefined, publisher: String(info.publisher || "") || undefined, subjects: Array.isArray(info.categories) ? info.categories.map(String).slice(0, 30) : [], isbn10, isbn13 };
}

async function googleRequest(path: string, options: BookRequestOptions = {}) {
  const separator = path.includes("?") ? "&" : "?";
  const apiKey = ((env as typeof env & { GOOGLE_BOOKS_API_KEY?: string }).GOOGLE_BOOKS_API_KEY || "").trim();
  const response = await fetch(`https://www.googleapis.com/books/v1${path}${apiKey ? `${separator}key=${encodeURIComponent(apiKey)}` : ""}`, { headers: { accept: "application/json" }, signal: options.signal || AbortSignal.timeout(9000) });
  if (!response.ok) throw new BooksApiError(`Google Books 返回 ${response.status}${response.status === 429 ? "：请配置 GOOGLE_BOOKS_API_KEY 或检查配额" : ""}`, response.status);
  return response.json() as Promise<{ items?: Array<{ id?: string; volumeInfo?: Record<string, unknown> }>; id?: string; volumeInfo?: Record<string, unknown> }>;
}

export async function searchGoogleBooks(query: string, options: BookRequestOptions = {}) {
  const payload = await googleRequest(`/volumes?q=${encodeURIComponent(query.trim().slice(0, 100))}&maxResults=8&printType=books`, options);
  return (payload.items || []).map(googleItem).filter((item): item is BookCatalogItem => Boolean(item));
}

export async function getGoogleBook(id: string, options: BookRequestOptions = {}) {
  const item = googleItem(await googleRequest(`/volumes/${encodeURIComponent(id)}`, options));
  if (!item) throw new BooksApiError(`Google Books 条目 ${id} 不存在`, 404);
  return item;
}

function openLibraryItem(item: Record<string, unknown>): BookCatalogItem | null {
  const id = String(item.key || "").replace(/^\/works\//, "").trim();
  const title = String(item.title || "").trim();
  if (!id || !title) return null;
  const identifiers = isbns(item.isbn);
  const coverId = Number(item.cover_i);
  return { provider: "open_library", id, title, originalTitle: title, authors: Array.isArray(item.author_name) ? item.author_name.map(String).slice(0, 20) : [], description: "", image: coverId > 0 ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "", year: Number(item.first_publish_year) || undefined, publisher: Array.isArray(item.publisher) ? String(item.publisher[0] || "") || undefined : undefined, subjects: Array.isArray(item.subject) ? item.subject.map(String).slice(0, 30) : [], ...identifiers };
}

export async function searchOpenLibrary(query: string, options: BookRequestOptions = {}) {
  const fields = "key,title,author_name,first_publish_year,isbn,cover_i,publisher,subject";
  const response = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query.trim().slice(0, 100))}&limit=8&fields=${fields}`, { headers: { accept: "application/json" }, signal: options.signal || AbortSignal.timeout(9000) });
  if (!response.ok) throw new BooksApiError(`Open Library 返回 ${response.status}`, response.status);
  const payload = await response.json() as { docs?: Record<string, unknown>[] };
  return (payload.docs || []).map(openLibraryItem).filter((item): item is BookCatalogItem => Boolean(item));
}

export async function getOpenLibraryBook(id: string, options: BookRequestOptions = {}) {
  const workId = id.replace(/^\/works\//, "");
  const response = await fetch(`https://openlibrary.org/works/${encodeURIComponent(workId)}.json`, { headers: { accept: "application/json" }, signal: options.signal || AbortSignal.timeout(9000) });
  if (!response.ok) throw new BooksApiError(`Open Library 返回 ${response.status}`, response.status);
  const item = await response.json() as Record<string, unknown>;
  const title = String(item.title || "").trim();
  if (!title) throw new BooksApiError(`Open Library 条目 ${id} 不存在`, 404);
  const description = typeof item.description === "string" ? item.description : item.description && typeof item.description === "object" ? String((item.description as Record<string, unknown>).value || "") : "";
  const coverId = Array.isArray(item.covers) ? Number(item.covers[0]) : 0;
  return { provider: "open_library", id: workId, title, originalTitle: title, authors: [], description, image: coverId > 0 ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "", year: year(item.first_publish_date), subjects: Array.isArray(item.subjects) ? item.subjects.map(String).slice(0, 30) : [] } satisfies BookCatalogItem;
}

function decodeXml(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

function xmlValue(block: string, names: string[]) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return decodeXml(match[1]).replace(/<[^>]+>/g, "").trim();
  }
  return "";
}

function ndlItems(xml: string): BookCatalogItem[] {
  return Array.from(xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)).map((match) => {
    const block = match[1];
    const title = xmlValue(block, ["title", "dc:title"]);
    const link = xmlValue(block, ["link", "guid"]);
    const identifier = xmlValue(block, ["dc:identifier", "identifier"]);
    const id = (link || identifier).split("/").filter(Boolean).pop() || "";
    const isbn = Array.from(block.matchAll(/<dc:identifier(?:\s[^>]*)?>([\s\S]*?)<\/dc:identifier>/gi)).map((entry) => decodeXml(entry[1].replace(/<[^>]+>/g, ""))).find((value) => /^(?:97[89])?\d{9}[\dX]$/i.test(value.replace(/-/g, "")))?.replace(/-/g, "");
    return { provider: "ndl" as const, id, title, originalTitle: title, authors: [xmlValue(block, ["dc:creator", "author"])].filter(Boolean), description: xmlValue(block, ["description", "dc:description"]), image: "", year: year(xmlValue(block, ["pubDate", "dc:date"])), publisher: xmlValue(block, ["dc:publisher"]) || undefined, subjects: [], ...(isbn?.length === 13 ? { isbn13: isbn } : isbn ? { isbn10: isbn } : {}) };
  }).filter((item) => item.id && item.title).slice(0, 8);
}

export async function searchNdl(query: string, options: BookRequestOptions = {}) {
  const response = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(query.trim().slice(0, 100))}&cnt=8`, { headers: { accept: "application/rss+xml, application/xml" }, signal: options.signal || AbortSignal.timeout(9000) });
  if (!response.ok) throw new BooksApiError(`NDL 返回 ${response.status}`, response.status);
  return ndlItems(await response.text());
}

export async function getNdlBook(id: string, options: BookRequestOptions = {}) {
  const normalizedId = id.trim().slice(0, 240);
  if (!normalizedId) throw new BooksApiError("NDL 条目 ID 无效", 400);
  const lookupId = normalizedId.match(/-I(.+)$/i)?.[1] || normalizedId;
  const response = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?any=${encodeURIComponent(lookupId)}&cnt=8`, { headers: { accept: "application/rss+xml, application/xml" }, signal: options.signal || AbortSignal.timeout(9000) });
  if (!response.ok) throw new BooksApiError(`NDL 返回 ${response.status}`, response.status);
  const items = ndlItems(await response.text());
  const item = items.find((candidate) => candidate.id === normalizedId || candidate.id.match(/-I(.+)$/i)?.[1] === lookupId);
  if (!item) throw new BooksApiError(`NDL 条目 ${normalizedId} 不存在`, 404);
  return item;
}
