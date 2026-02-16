export type Objective = "bookings" | "net_value";
export type SegmentBy = "none" | "loyalty_tier" | "price_sensitivity" | "device";
export type Method = "naive" | "dr";

export interface RecommendRequest {
  objective: Objective;
  max_discount_pct: number;
  segment_by: SegmentBy;
  method: Method;
}

export interface DeltaVsBaseline {
  bookings_per_10k: number;
  net_value_per_10k: number;
  avg_discount_pct: number;
}

export interface SegmentRecommendation {
  segment: string;
  recommended_discount_pct: number;
  expected_bookings_per_10k: number;
  expected_net_value_per_10k: number;
  delta_vs_baseline: DeltaVsBaseline;
}

export interface DoseResponsePoint {
  discount_pct: number;
  bookings_per_10k: number;
  net_value_per_10k: number;
  ci_low: number;
  ci_high: number;
}

export interface SegmentDoseResponse {
  segment: string;
  points: DoseResponsePoint[];
}

export interface RecommendResponse {
  artifact_version: string;
  method_used: Method;
  segments: SegmentRecommendation[];
  dose_response: SegmentDoseResponse[];
  baseline: {
    name: string;
    discount_pct: number;
  };
  warnings: string[];
  request_id?: string;
}

interface StaticBundle {
  artifact_version: string;
  treatment_levels: number[];
  recommendations: Record<string, RecommendResponse>;
}

export class ApiError extends Error {
  requestId?: string;

  constructor(message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.requestId = requestId;
  }
}

const RESPONSE_CACHE = new Map<string, RecommendResponse>();
const TIMEOUT_MS = 5_000;
const STATIC_MODE =
  import.meta.env.VITE_STATIC_MODE === "1" ||
  window.location.hostname.endsWith("github.io");

let staticBundlePromise: Promise<StaticBundle> | null = null;

function cacheKey(payload: RecommendRequest): string {
  return `${payload.objective}|${payload.max_discount_pct}|${payload.segment_by}|${payload.method}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function loadStaticBundle(): Promise<StaticBundle> {
  if (!staticBundlePromise) {
    const base = import.meta.env.BASE_URL || "/";
    const url = `${base}mock/recommendations.json`;
    staticBundlePromise = fetch(url).then(async (response) => {
      if (!response.ok) {
        throw new ApiError("Could not compute policy. Try again.");
      }
      return (await response.json()) as StaticBundle;
    });
  }

  return staticBundlePromise;
}

async function recommendFromStatic(payload: RecommendRequest): Promise<RecommendResponse> {
  const key = cacheKey(payload);
  const bundle = await loadStaticBundle();
  const result = bundle.recommendations[key];
  if (!result) {
    throw new ApiError("Could not compute policy. Try again.");
  }

  const cloned: RecommendResponse = {
    ...result,
    warnings: [...result.warnings]
  };
  RESPONSE_CACHE.set(key, cloned);
  return cloned;
}

export async function recommendPolicy(payload: RecommendRequest): Promise<RecommendResponse> {
  const key = cacheKey(payload);
  const cached = RESPONSE_CACHE.get(key);
  if (cached) {
    return cached;
  }

  if (STATIC_MODE) {
    return recommendFromStatic(payload);
  }

  let response: Response;
  try {
    response = await fetchWithTimeout("/api/v1/recommend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return recommendFromStatic(payload);
  }

  const requestId = response.headers.get("X-Request-Id") ?? undefined;
  if (!response.ok) {
    return recommendFromStatic(payload);
  }

  const data = (await response.json()) as RecommendResponse;
  data.request_id = data.request_id ?? requestId;
  RESPONSE_CACHE.set(key, data);
  return data;
}
