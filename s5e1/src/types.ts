export enum SessionStatus {
  CONTINUE = 'CONTINUE',
  END_OF_DATA = 'END_OF_DATA',
}

export enum DataType {
  TEXT = 'TEXT',
  BINARY = 'BINARY',
  NOISE = 'NOISE',
}

export enum BinarySubtype {
  IMAGE = 'IMAGE',
  AUDIO = 'AUDIO',
  JSON = 'JSON',
  TEXT_FILE = 'TEXT_FILE',
  PDF = 'PDF',
  UNKNOWN = 'UNKNOWN',
}

export interface ApiResponse {
  code: number;
  message: string;
  transcription?: string;
  meta?: string;
  attachment?: string;
  filesize?: number;
}

export interface ListenResult {
  status: SessionStatus;
  data: ApiResponse;
}

export interface RoutedData {
  type: DataType;
  subtype?: BinarySubtype;
  transcription?: string;
  binaryBuffer?: Buffer;
  mimeType?: string;
  filesize?: number;
}

export interface CityData {
  name: string;
  area: string;       // km², toFixed(2)
  warehouses?: number;
  phone?: string;
}

export interface ExtractedInfo {
  cityName?: string;
  cityArea?: string;
  warehousesCount?: number;
  phoneNumber?: string;
  cityList?: CityData[]; // all cities parsed from JSON binary — used for area lookup
}

export interface FinalReport {
  cityName: string;
  cityArea: string;
  warehousesCount: number;
  phoneNumber: string;
}
