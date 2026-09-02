import { useEffect, useState } from "react";
import {
  openTeamSupervisionResponseForm,
  type OpenTeamSupervisionResponseFormInput,
} from "./supervision-response-form-model";

export function useTeamSupervisionResponseFormModel(input: OpenTeamSupervisionResponseFormInput) {
  const [model] = useState(() => openTeamSupervisionResponseForm(input));
  useEffect(
    () => () => {
      model.close();
    },
    [model],
  );
  return model;
}
