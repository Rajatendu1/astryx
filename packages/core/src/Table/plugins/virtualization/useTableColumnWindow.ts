// Copyright (c) Meta Platforms, Inc. and affiliates.

'use client';

/**
 * @file useTableColumnWindow.ts
 * @input Admitted column pitches, pinned run sizes, the seed and shared inline geometry
 * @output Stable column and spacer segments in full-table column positions
 * @position Table pre-cell column planner; reads the parent's viewport, owns no observer
 */
import {useMemo, useState, useSyncExternalStore, type RefObject} from 'react';
import {useIsomorphicLayoutEffect} from '../../../hooks/useIsomorphicLayoutEffect';
import {useDevWarningPerMessage} from '../../../hooks/useDevWarning';
import {
  calculateVariableListRange,
  isPositiveFinite,
} from '../../../utils/listWindow';
import {
  getTableVirtualizationConfig,
  type TableVirtualizationCapability,
} from './useTableRowsVirtualization';
import {
  getTableColumnsVirtualizationConfig,
  type UseTableColumnsVirtualizationConfig,
} from './useTableColumnsVirtualization';

export type TableColumnSegment =
  | {type: 'columns'; start: number; end: number}
  | {type: 'gap'; start: number; end: number; width: number};

export interface TableInlineGeometry {
  isMeasured: boolean;
  viewportWidth?: number;
  scrollLeft?: number;
}
export interface TableInlineGeometrySource {
  subscribeInline: (onChange: () => void) => () => void;
  getSnapshot: () => TableInlineGeometry;
  getServerSnapshot: () => TableInlineGeometry;
}

export interface ResolvedTableVirtualization {
  /** The rows capability, passed on to the row planner unchanged. */
  rows?: TableVirtualizationCapability;
  columns?: Readonly<UseTableColumnsVirtualizationConfig>;
  /** Why the value cannot window at all. */
  invalidReason?: string;
}

/** One capability, or a list with at most one per axis. */
export function resolveTableVirtualization(
  value: unknown,
): ResolvedTableVirtualization {
  if (value == null) {
    return {};
  }
  const isList = Array.isArray(value);
  let rows: TableVirtualizationCapability | undefined;
  let columns: Readonly<UseTableColumnsVirtualizationConfig> | undefined;
  for (const item of isList ? (value as unknown[]) : [value]) {
    const columnsConfig = getTableColumnsVirtualizationConfig(item);
    if (getTableVirtualizationConfig(item) != null) {
      if (rows != null) {
        return {
          invalidReason:
            'a virtualization list holds more than one rows capability',
        };
      }
      rows = item as TableVirtualizationCapability;
    } else if (columnsConfig != null) {
      if (columns != null) {
        return {
          invalidReason:
            'a virtualization list holds more than one columns capability',
        };
      }
      columns = columnsConfig;
    } else {
      return {
        invalidReason: isList
          ? 'a virtualization list holds a value that is not a windowing capability'
          : 'virtualization is not a value from useTableRowsVirtualization or useTableColumnsVirtualization',
      };
    }
  }
  return {rows, columns};
}

export interface UseTableColumnWindowOptions {
  config: Readonly<UseTableColumnsVirtualizationConfig> | undefined;
  isAdmitted: boolean;
  /** The pitch of each column, in full-table order. */
  widths: ReadonlyArray<number>;
  /** Columns in the pinned start run, from the first column. */
  startCount: number;
  /** Columns in the pinned end run, through the last column. */
  endCount: number;
  table: RefObject<HTMLTableElement | null>;
  geometry: TableInlineGeometrySource;
}
export interface TableColumnWindowResult {
  segments: ReadonlyArray<TableColumnSegment>;
  /** True while at least one column is not mounted. */
  isWindowed: boolean;
}

const OVERSCAN = 2;
const UNMEASURED: TableInlineGeometry = Object.freeze({isMeasured: false});
const getUnmeasured = () => UNMEASURED;
const subscribeToNothing = () => () => {};

/** Why mounted header or body cells cannot window, if they cannot. */
function getColumnViolation(table: HTMLTableElement): string | undefined {
  for (const row of Array.from(table.rows)) {
    if (row.getAttribute('aria-hidden') === 'true') {
      continue;
    }
    for (const cell of Array.from(row.cells)) {
      if (cell.getAttribute('aria-hidden') !== 'true' && cell.colSpan > 1) {
        return 'a cell spans columns';
      }
    }
  }
  return undefined;
}

export function useTableColumnWindow({
  config,
  isAdmitted,
  widths,
  startCount,
  endCount,
  table,
  geometry,
}: UseTableColumnWindowOptions): TableColumnWindowResult {
  const columnCount = widths.length;
  const runStart = Math.min(columnCount, Math.max(0, startCount));
  const runEnd = Math.max(runStart, columnCount - Math.max(0, endCount));
  const [rejected, setRejected] = useState<{
    widths: ReadonlyArray<number>;
    config: Readonly<UseTableColumnsVirtualizationConfig> | undefined;
    reason: string;
  }>();
  const isRejected = rejected?.widths === widths && rejected.config === config;
  useDevWarningPerMessage(
    'Table',
    `Column windowing disabled: ${rejected?.reason}. Rendering every column.`,
    isRejected,
  );
  const canWindow =
    isAdmitted &&
    !isRejected &&
    config !== undefined &&
    isPositiveFinite(config.initialViewportWidth) &&
    runEnd > runStart &&
    widths.every(width => Number.isFinite(width) && width >= 0);
  const snapshot = useSyncExternalStore(
    canWindow ? geometry.subscribeInline : subscribeToNothing,
    canWindow ? geometry.getSnapshot : getUnmeasured,
    canWindow ? geometry.getServerSnapshot : getUnmeasured,
  );
  // Prefix offsets of the windowed run, and the pinned run sizes.
  const layout = useMemo(() => {
    const offsets = [0];
    for (let index = runStart; index < runEnd; index++) {
      offsets.push(offsets[offsets.length - 1] + widths[index]);
    }
    let pinnedStart = 0;
    for (let index = 0; index < runStart; index++) {
      pinnedStart += widths[index];
    }
    let pinnedEnd = 0;
    for (let index = runEnd; index < columnCount; index++) {
      pinnedEnd += widths[index];
    }
    return {offsets, pinnedStart, pinnedEnd};
  }, [widths, runStart, runEnd, columnCount]);

  const isMeasured =
    snapshot.isMeasured &&
    isPositiveFinite(snapshot.viewportWidth ?? 0) &&
    Number.isFinite(snapshot.scrollLeft ?? 0);
  // The pinned runs cover the viewport's edges, so only the space between
  // them shows the windowed run. The seed plans for the same space.
  const viewportSize =
    (isMeasured
      ? (snapshot.viewportWidth ?? 0)
      : (config?.initialViewportWidth ?? 0)) -
    layout.pinnedStart -
    layout.pinnedEnd;
  const range = canWindow
    ? calculateVariableListRange({
        offsets: layout.offsets,
        viewportSize,
        scrollOffset: isMeasured ? (snapshot.scrollLeft ?? 0) : 0,
        isMeasured,
        overscan: OVERSCAN,
      })
    : undefined;
  const runCount = runEnd - runStart;
  const isWindowed =
    range !== undefined && (range.start > 0 || range.end < runCount);
  const start = isWindowed ? runStart + range.start : 0;
  const end = isWindowed ? runStart + range.end : columnCount;

  // A scroll inside the mounted range keeps the exact segment array.
  const segments = useMemo<TableColumnSegment[]>(() => {
    if (!isWindowed) {
      return columnCount === 0
        ? []
        : [{type: 'columns', start: 0, end: columnCount}];
    }
    const width = (from: number, to: number) =>
      layout.offsets[to - runStart] - layout.offsets[from - runStart];
    const next: TableColumnSegment[] = [];
    if (runStart > 0) {
      next.push({type: 'columns', start: 0, end: runStart});
    }
    if (start > runStart) {
      next.push({
        type: 'gap',
        start: runStart,
        end: start,
        width: width(runStart, start),
      });
    }
    next.push({type: 'columns', start, end});
    if (end < runEnd) {
      next.push({
        type: 'gap',
        start: end,
        end: runEnd,
        width: width(end, runEnd),
      });
    }
    if (runEnd < columnCount) {
      next.push({type: 'columns', start: runEnd, end: columnCount});
    }
    return next;
  }, [isWindowed, start, end, runStart, runEnd, columnCount, layout]);

  // Spanning cells come from plugin transforms, so they are known only after
  // they mount. Reads only mounted cells; one such cell renders every column.
  useIsomorphicLayoutEffect(() => {
    if (!isWindowed || table.current == null) {
      return;
    }
    const reason = getColumnViolation(table.current);
    if (reason) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect -- records a violation read from mounted cells
      setRejected({widths, config, reason});
    }
  }, [isWindowed, segments, table, widths, config]);

  return useMemo(() => ({segments, isWindowed}), [segments, isWindowed]);
}
