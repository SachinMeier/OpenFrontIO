import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { zInt, zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { ShellExecution } from "./ShellExecution";

export class DefensePostExecution implements Execution {
  private mg: Game;
  private active: boolean = true;

  private target: Unit | null = null;
  private lastShellAttack = 0;

  private alreadySentShell = new Set<Unit>();

  constructor(private post: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  private shoot() {
    if (this.target === null) return;
    const shellAttackRate = this.mg.config().defensePostShellAttackRate();
    if (this.mg.ticks() - this.lastShellAttack > shellAttackRate) {
      this.lastShellAttack = this.mg.ticks();
      this.mg.addExecution(
        new ShellExecution(
          this.post.tile(),
          this.post.owner(),
          this.post,
          this.target,
        ),
      );
      if (!this.target.hasHealth()) {
        // Don't send multiple shells to target that can be oneshotted
        this.alreadySentShell.add(this.target);
        this.target = null;
        return;
      }
    }
  }

  // Nearest enemy ship in range, transports first. Recomputed every tick: the
  // post can change hands, which changes who counts as an enemy.
  private findTarget(): Unit | null {
    const owner = this.post.owner();
    const ships = this.mg.nearbyUnits(
      this.post.tile(),
      this.mg.config().defensePostTargettingRange(),
      [UnitType.TransportShip, UnitType.Warship],
    );
    let best: Unit | null = null;
    let bestIsTransport = false;
    let bestDistSquared = 0;
    for (const { unit, distSquared } of ships) {
      if (
        unit.owner() === owner ||
        !owner.canAttackPlayer(unit.owner(), true) ||
        this.alreadySentShell.has(unit) ||
        (unit.type() === UnitType.Warship &&
          unit.warshipState().state === "docked")
      ) {
        continue;
      }
      const isTransport = unit.type() === UnitType.TransportShip;
      if (
        best === null ||
        (isTransport && !bestIsTransport) ||
        (isTransport === bestIsTransport && distSquared < bestDistSquared)
      ) {
        best = unit;
        bestIsTransport = isTransport;
        bestDistSquared = distSquared;
      }
    }
    return best;
  }

  tick(ticks: number): void {
    if (!this.post.isActive()) {
      this.active = false;
      return;
    }

    // Do nothing while the structure is under construction
    if (this.post.isUnderConstruction()) {
      return;
    }

    for (const unit of this.alreadySentShell) {
      if (!unit.isActive()) this.alreadySentShell.delete(unit);
    }

    this.target = this.findTarget();
    this.shoot();
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DefensePostExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      post: w.unit(this.post),
      target: w.unitOrNull(this.target),
      lastShellAttack: this.lastShellAttack,
      alreadySentShell: [...this.alreadySentShell].map((u) => w.unit(u)),
    });
  }

  restoreSnapshot(s: DefensePostState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.post = r.unit(s.post);
    this.target = r.unitOrNull(s.target);
    this.lastShellAttack = s.lastShellAttack;
    this.alreadySentShell = new Set(s.alreadySentShell.map((i) => r.unit(i)));
  }
}

const DefensePostStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  post: zRef(),
  target: zRef().nullable(),
  lastShellAttack: zInt(),
  alreadySentShell: z.array(zRef()),
});
type DefensePostState = z.infer<typeof DefensePostStateSchema>;

export const DefensePostExecutionSnapshot = execSnapshotType({
  name: "DefensePost",
  version: 1,
  schema: DefensePostStateSchema,
  cls: () => DefensePostExecution,
});
