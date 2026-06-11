export type JsonRecord = Record<string, unknown>;

export type AuthUser = {
  id: string;
  subject_type: string;
  phone?: string | null;
  email?: string | null;
  role?: string | null;
};

export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in: number;
  user: AuthUser;
};

export type StoredSession = TokenPair & {
  device_id: string;
  saved_at: number;
};

export type FieldType =
  | "text"
  | "email"
  | "password"
  | "number"
  | "textarea"
  | "checkbox"
  | "json"
  | "select";

export type AdminField = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  wide?: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: string }>;
  relation?: {
    moduleKey: string;
    valueField?: string;
    labelFields?: string[];
  };
  emptyAsNull?: boolean;
  parser?: "number" | "integer" | "json";
};

export type UploadAction = {
  key: string;
  label: string;
  path: (record: JsonRecord) => string;
  fieldName: string;
  multiple?: boolean;
  accept?: string;
  extraFields?: AdminField[];
};

export type AdminModule = {
  key: string;
  title: string;
  tableName: string;
  description: string;
  listPath: string;
  createPath: string;
  updatePath: (record: JsonRecord) => string;
  deletePath: (record: JsonRecord) => string;
  idField: string;
  columns: string[];
  fields: AdminField[];
  uploads?: UploadAction[];
  details?: Array<{ label: string; name: string }>;
  supportsStorySlides?: boolean;
  supportsMenuBrowser?: boolean;
  supportsBookingImages?: boolean;
};
