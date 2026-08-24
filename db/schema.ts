import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const userState = sqliteTable("user_state", {
  userKey: text("user_key").primaryKey(),
  animeJson: text("anime_json").notNull(),
  collectionsJson: text("collections_json").notNull().default("[]"),
  bangumiSyncTypesJson: text("bangumi_sync_types_json").notNull().default("[]"),
  mediaOrderJson: text("media_order_json").notNull().default("[]"),
  deviceSubcategoriesJson: text("device_subcategories_json").notNull().default("{}"),
  deviceCategoryLabelsJson: text("device_category_labels_json").notNull().default("{}"),
  visualSubtypeLabelsJson: text("visual_subtype_labels_json").notNull().default("{}"),
  videoSubtypeLabelsJson: text("video_subtype_labels_json").notNull().default("{}"),
  avatarImage: text("avatar_image").notNull().default(""),
  openClawUrl: text("openclaw_url").notNull().default(""),
  openClawAgent: text("openclaw_agent").notNull().default("hikari"),
  font: text("font").notNull().default("modern"),
  softness: integer("softness").notNull().default(72),
  backgroundVersion: integer("background_version").notNull().default(0),
  primaryColor: text("primary_color").notNull().default("#66CCFF"),
  accentColor: text("accent_color").notNull().default("#8B8CD8"),
  titleMode: text("title_mode").notNull().default("cn"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * 媒体收藏条目（user_subjects）。
 * `type` 支持 9 大分类：
 *   anime        动画
 *   movie        电影
 *   tv           电视剧
 *   game         游戏
 *   light_novel  书籍（兼容既有轻小说记录）
 *   manga        漫画
 *   music        音乐
 *   visual       画廊视觉收藏
 *   video        视频元数据收藏
 * 媒体记录以该表为规范化主数据；user_state.anime_json 仅作为旧 schema 的
 * 非管理兼容列保留，状态 API 不再读取或写入媒体快照。
 */
export const userSubjects = sqliteTable(
  "user_subjects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userKey: text("user_key").notNull(),
    type: text("type").notNull(), // anime | movie | tv | game | light_novel | manga | music | visual | video
    subjectId: integer("subject_id"),
    title: text("title").notNull(),
    jp: text("jp").notNull().default(""),
    note: text("note").notNull().default(""),
    progress: integer("progress").notNull().default(0),
    total: integer("total").notNull().default(12),
    status: text("status").notNull().default("watching"),
    kind: text("kind").notNull().default("coral"),
    score: integer("score"),
    next: text("next"),
    image: text("image"),
    globalScore: real("global_score"),
    source: text("source").notNull().default("manual"), // bangumi | manual | local
    collection: text("collection").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    musicAlbum: text("music_album").notNull().default(""),
    musicArtist: text("music_artist").notNull().default(""),
    lyricist: text("lyricist").notNull().default(""),
    composer: text("composer").notNull().default(""),
    animeSong: integer("anime_song", { mode: "boolean" }).notNull().default(false),
    visualSubtype: text("visual_subtype").notNull().default("other"),
    videoSubtype: text("video_subtype").notNull().default("other"),
    thumbnail: text("thumbnail").notNull().default(""),
    sourceUrl: text("source_url").notNull().default(""),
    pixivPid: text("pixiv_pid").notNull().default(""),
    author: text("author").notNull().default(""),
    twitterSource: text("twitter_source").notNull().default(""),
    characterTags: text("character_tags").notNull().default("[]"),
    metadata: text("metadata").notNull().default("{}"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("user_subjects_user_key_idx").on(table.userKey),
    index("user_subjects_user_type_idx").on(table.userKey, table.type),
  ],
);

/**
 * 装备库（user_devices）。
 * `category` 4 大类：
 *   audio               音频
 *   gaming_wearable     游戏穿戴
 *   pc_hardware         电脑硬件
 *   mobile_accessories  移动配件
 * `status`：active（在役）/ backup（备用）/ retired（退役）
 * `price` 为入手价，`currency` 默认 CNY；`purchaseDate` 为入手日期（YYYY-MM-DD）。
 * `receiptImage` 为购买凭证截图地址；`tags` 以 JSON 数组字符串存储（如平头塞/3DoF/LDAC）。
 */
export const userDevices = sqliteTable(
  "user_devices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userKey: text("user_key").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(), // audio | gaming_wearable | pc_hardware | mobile_accessories
    subCategory: text("sub_category").notNull().default(""),
    status: text("status").notNull().default("active"), // active | backup | retired
    price: real("price"),
    currency: text("currency").notNull().default("CNY"),
    purchaseDate: text("purchase_date"),
    receiptImage: text("receipt_image"),
    coverImage: text("cover_image"),
    tags: text("tags").notNull().default("[]"),
    rating: integer("rating"),
    review: text("review").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("user_devices_user_key_idx").on(table.userKey),
    index("user_devices_user_category_idx").on(table.userKey, table.category),
    index("user_devices_user_status_idx").on(table.userKey, table.status),
  ],
);

/**
 * OpenClaw Agent 操作审计与幂等记录。
 * 所有 Agent 写入都保留 source=openclaw、Agent 名称和请求幂等键。
 */
export const agentOperations = sqliteTable(
  "agent_operations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userKey: text("user_key").notNull(),
    source: text("source").notNull().default("openclaw"),
    agent: text("agent").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    resourceId: integer("resource_id"),
    statusCode: integer("status_code").notNull().default(200),
    responseJson: text("response_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_operations_idempotency_idx").on(table.userKey, table.agent, table.idempotencyKey),
    index("agent_operations_user_created_idx").on(table.userKey, table.createdAt),
  ],
);

/** The single web administrator account. There is intentionally no user table. */
export const adminAccount = sqliteTable("admin_account", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecret: text("totp_secret").notNull().default(""),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
  backupCodes: text("backup_codes").notNull().default("[]"),
  sessionDuration: integer("session_duration").notNull().default(2592000),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("admin_account_username_idx").on(table.username)]);

/** Browser sessions. Pending rows are short-lived 2FA challenges, not usable sessions. */
export const adminSessions = sqliteTable("admin_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionTokenHash: text("session_token_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
  userAgent: text("user_agent").notNull().default(""),
  deviceName: text("device_name").notNull().default(""),
  ip: text("ip").notNull().default(""),
  pending: integer("pending", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  index("admin_sessions_token_idx").on(table.sessionTokenHash),
  index("admin_sessions_expires_idx").on(table.expiresAt),
]);

export const adminAuthLogs = sqliteTable("admin_auth_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  event: text("event").notNull(),
  username: text("username").notNull().default(""),
  sessionId: integer("session_id"),
  ip: text("ip").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("admin_auth_logs_event_created_idx").on(table.event, table.createdAt)]);

/** Encrypted Bangumi credentials for the single administrator. */
export const bangumiAccount = sqliteTable("bangumi_account", {
  adminId: integer("admin_id").primaryKey(),
  bangumiUserId: integer("bangumi_user_id").notNull(),
  username: text("username").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenExpiresAt: integer("token_expires_at", { mode: "timestamp_ms" }),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Encrypted third-party credentials configured by the single administrator. */
export const externalServiceCredentials = sqliteTable("external_service_credentials", {
  provider: text("provider").primaryKey(),
  adminId: integer("admin_id").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  metadata: text("metadata").notNull().default("{}"),
  lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("external_service_credentials_admin_idx").on(table.adminId)]);

/**
 * Normalized broadcast schedule data. `subjectId` is the external Bangumi
 * subject id; a user's `user_subjects.subject_id` is joined at read time so
 * schedules stay independent from personal collection records.
 */
export const animeAiringSchedule = sqliteTable(
  "anime_airing_schedule",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subjectId: integer("subject_id").notNull(),
    title: text("title").notNull(),
    jpTitle: text("jp_title").notNull().default(""),
    weekday: integer("weekday").notNull(),
    airTime: text("air_time").notNull().default(""),
    timezone: text("timezone").notNull().default("Asia/Tokyo"),
    nextEpisode: integer("next_episode"),
    nextAirAt: integer("next_air_at", { mode: "timestamp_ms" }),
    season: text("season").notNull(),
    year: integer("year").notNull(),
    source: text("source").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    lastChecked: integer("last_checked", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("anime_airing_schedule_source_subject_season_idx").on(table.source, table.subjectId, table.season, table.year),
    index("anime_airing_schedule_year_season_idx").on(table.year, table.season),
    index("anime_airing_schedule_weekday_idx").on(table.weekday),
  ],
);
