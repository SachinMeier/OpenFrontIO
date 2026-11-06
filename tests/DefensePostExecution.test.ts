import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { DefensePostExecution } from "@openfront/engine/execution/DefensePostExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

const MAP = "big_plains";
const POST = { x: 10, y: 10 };

let game: Game;
let a: Player;
let b: Player;
let post: Unit;

function transport(owner: Player, x: number, y: number): Unit {
  return owner.buildUnit(UnitType.TransportShip, game.ref(x, y), {
    troops: 100,
  });
}

function warship(owner: Player, x: number, y: number): Unit {
  return owner.buildUnit(UnitType.Warship, game.ref(x, y), {
    patrolTile: game.ref(x, y),
  });
}

describe("DefensePostExecution", () => {
  beforeEach(async () => {
    game = await setup(MAP, { infiniteGold: true, instantBuild: true }, [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ]);
    a = game.player("alice");
    b = game.player("bob");
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) a.conquer(game.ref(x, y));
    }
    for (let x = 180; x < 200; x++) {
      for (let y = 180; y < 200; y++) b.conquer(game.ref(x, y));
    }
    post = a.buildUnit(UnitType.DefensePost, game.ref(POST.x, POST.y), {});
    game.addExecution(new DefensePostExecution(post));
    // The first shot waits out one reload from tick 0.
    executeTicks(game, game.config().defensePostShellAttackRate() + 1);
  });

  test("shells an enemy transport in range", () => {
    const boat = transport(b, 30, 10);
    executeTicks(game, 30);
    expect(boat.isActive()).toBe(false);
  });

  test("shells an enemy warship in range", () => {
    const ship = warship(b, 30, 10);
    const health = ship.health();
    executeTicks(game, 30);
    expect(ship.health()).toBeLessThan(health);
  });

  test("ignores ships out of range", () => {
    const range = game.config().defensePostTargettingRange();
    transport(b, POST.x + range + 5, POST.y);
    executeTicks(game, 10);
    expect(a.units(UnitType.Shell)).toHaveLength(0);
  });

  test("ignores own and allied ships", () => {
    game.addExecution(new AllianceRequestExecution(a, b.id()));
    game.executeNextTick();
    game.addExecution(new AllianceRequestExecution(b, a.id()));
    game.executeNextTick();
    expect(a.isAlliedWith(b)).toBe(true);

    transport(a, 30, 10);
    transport(b, 30, 12);
    executeTicks(game, 10);
    expect(a.units(UnitType.Shell)).toHaveLength(0);
  });

  test("prefers transports over a closer warship", () => {
    game.config().defensePostShellAttackRate = () => Number.MAX_SAFE_INTEGER;
    const ship = warship(b, 15, 10);
    const boat = transport(b, 40, 10);
    const exec = new DefensePostExecution(post);
    exec.init(game, game.ticks());
    exec.tick(game.ticks());
    expect(exec["target"]).toBe(boat);
    expect(exec["target"]).not.toBe(ship);
  });

  test("fires at the warship cadence", () => {
    const rate = game.config().defensePostShellAttackRate();
    expect(rate).toBe(game.config().warshipShellAttackRate());
    const ship = warship(b, 30, 10);
    const shells = new Set<Unit>();
    for (let i = 0; i < 3 * rate; i++) {
      game.executeNextTick();
      for (const shell of a.units(UnitType.Shell)) shells.add(shell);
    }
    // One shot per reload: at offsets 0, rate + 1 and 2 * rate + 2.
    expect(shells.size).toBe(3);
    expect(ship.isActive()).toBe(true);
  });

  test("stays inert while under construction", async () => {
    game = await setup(MAP, { infiniteGold: true }, [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ]);
    a = game.player("alice");
    b = game.player("bob");
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) a.conquer(game.ref(x, y));
    }
    game.addExecution(
      new ConstructionExecution(a, UnitType.DefensePost, game.ref(10, 10)),
    );
    executeTicks(game, 3);
    const built = a.units(UnitType.DefensePost)[0];
    expect(built.isUnderConstruction()).toBe(true);
    transport(b, 30, 10);
    executeTicks(game, game.config().defensePostShellAttackRate() + 5);
    expect(built.isUnderConstruction()).toBe(true);
    expect(a.units(UnitType.Shell)).toHaveLength(0);
  });

  test("serves the new owner after capture", () => {
    b.captureUnit(post);
    const alices = transport(a, 30, 10);
    const bobs = transport(b, 30, 12);
    executeTicks(game, 30);
    expect(alices.isActive()).toBe(false);
    expect(bobs.isActive()).toBe(true);
  });

  test("forgets dead ships it already shelled", () => {
    const boat = transport(b, 30, 10);
    executeTicks(game, 30);
    expect(boat.isActive()).toBe(false);
    const exec = game
      .executions()
      .find((e) => e instanceof DefensePostExecution) as DefensePostExecution;
    expect(exec["alreadySentShell"].size).toBe(0);
  });

  test("round-trips a snapshot mid-engagement", async () => {
    warship(b, 30, 10);
    transport(b, 40, 15);
    executeTicks(game, 2);
    expect(a.units(UnitType.Shell).length).toBeGreaterThan(0);
    await expectSnapshotRoundTrip(game, MAP, 40);
  });
});
