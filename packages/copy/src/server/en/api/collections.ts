// Server copy: apps/api/src/services/collections.ts
export default {
  nameInUse: (table: string, name: string) => `You already have a ${table === "baskets" ? "basket" : "collection"} called “${name}”. Pick another name.`,
  onlyFilterCollections: "Only filter collections have a filter.",
  notGroupingSources: "This collection doesn't group sources.",
  takenDownHosted: "PURSS took this shared page down after a report, so it can't be deleted until the report is reviewed.",
  takenDownAdministrator: "An administrator took this shared page down after a report, so it can't be deleted until they restore the page.",
  reviewConfirm: "Please review what will happen and confirm again.",
  reviewDeleteConfirm: "Please review what will be deleted and confirm again.",
};
