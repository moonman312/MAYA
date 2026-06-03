export type MewsCredentialsInput = {
  clientToken: string;
  accessToken: string;
  enterpriseId?: string;
  baseUrl?: string;
};

export type ResolvedMewsCredentials = MewsCredentialsInput & {
  baseUrl: string;
};

/**
 * Metadata-only shape of a `pms_connections` row. Credentials are NOT here —
 * they live in `pms_connection_secrets` (Vault-backed) and are retrieved via
 * the `pms_secret_get` RPC, not via direct table SELECT.
 */
export type PmsConnectionRow = {
  id: string;
  hotel_id: string;
  pms_type: string;
  base_url: string | null;
  status: string;
};
