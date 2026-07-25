import {
  searchOrganizationPeopleRemote,
  type SearchOrganizationPeopleInput,
  type SearchOrganizationPeopleResult,
} from "@/lib/edgebase";

interface OrganizationPeopleTypeaheadHandlers {
  delayMs?: number;
  onError: () => void;
  onResult: (result: SearchOrganizationPeopleResult) => void;
}

export function scheduleOrganizationPeopleTypeahead(
  input: SearchOrganizationPeopleInput,
  handlers: OrganizationPeopleTypeaheadHandlers,
) {
  let active = true;
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    void searchOrganizationPeopleRemote(input, { signal: controller.signal }).then(
      (result) => {
        if (active) handlers.onResult(result);
      },
      () => {
        if (active) handlers.onError();
      },
    );
  }, handlers.delayMs ?? 120);

  return () => {
    active = false;
    window.clearTimeout(timer);
    controller.abort();
  };
}
