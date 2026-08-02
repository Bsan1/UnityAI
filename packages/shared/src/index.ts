export interface HealthResponse {
  readonly status: "ok";
  readonly app: string;
  readonly version: string;
  readonly milestone: string;
}
