export interface RiskSurfaceRegion {
  key: string;
  label: string;
  pnl: number | null;
  isDeadZone: boolean;
  isDoubleWin: boolean;
}

export interface RiskSurface3DProps {
  title: string;
  lowerStrike: number | null;
  upperStrike: number | null;
  premium: number | null;
  worstCasePnl: number | null;
  bestCasePnl: number | null;
  guaranteedEdge: number | null;
  regions: RiskSurfaceRegion[];
}
