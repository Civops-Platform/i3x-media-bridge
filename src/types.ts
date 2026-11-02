// The few i3X shapes this bridge needs, copied from the i3X 1.0 wire format so
// the package stands alone. Structural: a host's own VQT and sink types fit.

/** One value, with quality and source timestamp, as i3X serves it. */
export interface VQT {
  attributeId: string;
  value: number | string | boolean | null;
  quality: "Good" | "GoodNoData" | "Bad" | "Uncertain";
  timestamp: string;
}

export type Quality = VQT["quality"];

/** Which source an attribute reads from, and where in it. */
export interface Binding {
  source: string;
  /** For the gateway driver: <path>#online | #bitrateKbps | #viewers | #tracks */
  address: string;
}

export interface SourceDef {
  id: string;
  endpoint?: string;
  /** For the gateway driver: { pollMs } (default 2000). */
  options?: Record<string, unknown>;
}

/** Where a driver puts what it reads. It never invents a value. */
export interface DriverSink {
  value(attributeId: string, value: VQT["value"], quality: Quality, sourceTimestamp: string): void;
  /** The source is gone: every attribute it feeds is Bad. */
  lost(reason: string): void;
  /** Mark one attribute's quality without a new value (last value kept; Bad clears it on read). */
  degrade?(attributeId: string, quality: Quality): void;
  restored(): void;
}

export interface Driver {
  readonly source: SourceDef;
  start(points: Array<{ attributeId: string; binding: Binding }>, sink: DriverSink): Promise<void>;
  stop(): Promise<void>;
  status(): { connected: boolean; detail: string };
}
