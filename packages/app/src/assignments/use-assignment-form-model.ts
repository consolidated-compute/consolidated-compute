import { useEffect, useState } from "react";
import { openAssignmentForm, type AssignmentFormSnapshot } from "./form-model";

export function useAssignmentFormModel(snapshot: AssignmentFormSnapshot) {
  const [model] = useState(() => openAssignmentForm(snapshot));

  useEffect(
    () => () => {
      model.close();
    },
    [model],
  );

  useEffect(() => model.applyHosts(snapshot.hosts), [model, snapshot.hosts]);

  return model;
}
