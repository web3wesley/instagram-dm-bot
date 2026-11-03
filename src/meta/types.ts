/** The Graph API surface the bot uses. `client.ts` implements it; tests use a fake. */

export interface MeInfo {
  /** Instagram professional account ID (`user_id`) — matches webhook `entry.id`. */
  userId: string;
  username: string;
  /** App-scoped user ID (`id`). */
  appScopedId?: string | undefined;
  accountType?: string | undefined;
}

export interface ApiMedia {
  id: string;
  timestamp?: string;
  comments_count?: number;
  shortcode?: string;
  permalink?: string;
  media_product_type?: string;
}

export interface ApiComment {
  id: string;
  text?: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
  username?: string;
  parent_id?: string;
  replies?: { data?: ApiComment[] };
}

export interface Page<T> {
  data: T[];
  /** Cursor for the next page, when there is one. */
  next?: string | undefined;
}

export interface SendResult {
  /** IGSID of the recipient (for private replies: the commenter's messaging ID). */
  recipientId: string;
  messageId: string;
}

export interface TokenGrant {
  accessToken: string;
  expiresInS?: number | undefined;
  userId?: string | undefined;
  permissions?: string[] | undefined;
}

export interface MetaClient {
  getMe(token?: string): Promise<MeInfo>;
  getMedia(id: string): Promise<ApiMedia>;
  listMedia(limit: number): Promise<ApiMedia[]>;
  listComments(mediaId: string, o: { after?: string | undefined; replies: boolean }): Promise<Page<ApiComment>>;

  /** The ONE private reply Meta allows per comment (within 7 days). */
  sendPrivateReply(commentId: string, text: string): Promise<SendResult>;
  /** A regular DM — only inside the 24 h window opened by the person's own message. */
  sendText(igsid: string, text: string): Promise<SendResult>;
  /** Public reply under a comment. */
  replyToComment(commentId: string, text: string): Promise<{ id: string }>;

  subscribe(fields: readonly string[]): Promise<boolean>;
  subscribedFields(): Promise<string[]>;
  exchangeCode(code: string, redirectUri: string): Promise<TokenGrant>;
  toLongLived(shortToken: string): Promise<TokenGrant>;
  refresh(token: string): Promise<TokenGrant>;
}

/** Webhook fields the bot needs (comments trigger; messages + postbacks release the link). */
export const SUBSCRIBED_FIELDS = ['comments', 'messages', 'messaging_postbacks'] as const;

/** Business Login scopes. */
export const OAUTH_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
] as const;
