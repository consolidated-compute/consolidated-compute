import { expect, test } from "vitest";
import { openSecuritySetupForm, type SecuritySetupPort } from "./security-setup-model";

function fixture(needsCode = true) {
  const calls: string[] = [];
  const port: SecuritySetupPort = {
    async save() {
      calls.push("save");
    },
    async remember() {
      calls.push("remember");
    },
    async restart() {
      calls.push("restart");
    },
  };
  const model = openSecuritySetupForm(port, needsCode);
  model.setPassword("a-secure-test-password");
  model.setConfirmation("a-secure-test-password");
  return { port, model, calls };
}

test("browser requires a code and matching bounded passwords; saving never restarts", async () => {
  const { model, calls } = fixture();
  expect(model.getState().canSave).toBe(false);
  model.setCode("private-code");
  expect(model.getState().canSave).toBe(true);
  model.setConfirmation("different password");
  await model.save();
  expect(calls).toEqual([]);
  model.setConfirmation("a-secure-test-password");
  await model.save();
  expect(calls).toEqual(["save", "remember"]);
  expect(model.getState()).toMatchObject({ stage: "saved", password: "", code: "" });
  await model.restart();
  expect(calls).toEqual(["save", "remember", "restart"]);
  expect(model.getState().stage).toBe("ready");
});

test("credential storage retry does not repeat daemon mutation", async () => {
  const { model, port, calls } = fixture(false);
  port.remember = async () => {
    throw new Error("storage unavailable");
  };
  await model.save();
  expect(model.getState().error).toBe("storage unavailable");
  port.remember = async () => {
    calls.push("remember");
  };
  await model.save();
  expect(calls).toEqual(["save", "remember"]);
});

test("closing during save clears secrets and prevents late publication", async () => {
  const { model, port } = fixture(false);
  let finish: (() => void) | undefined;
  port.save = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const saving = model.save();
  model.close();
  const closed = model.getState();
  expect(closed.password).toBe("");
  expect(finish).toBeDefined();
  finish?.();
  await saving;
  expect(model.getState()).toBe(closed);
});

test("rejects whitespace and UTF-8 passwords that bcrypt would truncate", () => {
  const { model } = fixture(false);
  for (const password of ["short", " surrounding spaces ", "é".repeat(40)]) {
    model.setPassword(password);
    model.setConfirmation(password);
    expect(model.getState().canSave).toBe(false);
  }
});
