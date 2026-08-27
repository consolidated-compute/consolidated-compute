import { useEffect, useState } from "react";
import { openTeamRunForm, type TeamRunFormSnapshot } from "./run-form-model";

export function useTeamRunFormModel(snapshot: TeamRunFormSnapshot) {
  const [model] = useState(() => openTeamRunForm(snapshot));

  useEffect(
    () => () => {
      model.close();
    },
    [model],
  );

  useEffect(() => {
    model.applyWorkspaces(snapshot.workspaces);
    model.applyProfiles(snapshot.profiles ?? null);
  }, [model, snapshot.profiles, snapshot.workspaces]);

  return model;
}
