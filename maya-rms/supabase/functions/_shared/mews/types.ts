export type MewsCredentialsInput = {
  clientToken: string;
  accessToken: string;
  enterpriseId?: string;
  baseUrl?: string;
};

export type ResolvedMewsCredentials = MewsCredentialsInput & {
  baseUrl: string;
};

export type PmsConnectionRow = {
  id: string;
  hotel_id: string;
  pms_type: string;
  base_url: string | null;
  credentials_encrypted: string;
  status: string;
};
