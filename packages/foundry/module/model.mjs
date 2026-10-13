import { PAGE_SYSTEM_FIELDS } from "./domain/journal.mjs";

export { PAGE_SYSTEM_FIELDS };

export function defineLegendKeeperPageModel(foundry) {
  const fields = foundry.data.fields;
  class LegendKeeperPageModel extends foundry.abstract.TypeDataModel {
    static defineSchema() {
      return {
        lkResourceId: new fields.StringField({ required: true, blank: false }),
        lkDocumentId: new fields.StringField({ required: true, blank: false }),
        version: new fields.StringField({ required: false, blank: true, initial: "" }),
        isFullWidth: new fields.BooleanField({ initial: false }),
        placeholder: new fields.StringField({ required: false, blank: true, initial: "" }),
        blocks: new fields.ArrayField(new fields.ObjectField()),
        banner: new fields.ObjectField({ required: false, nullable: true, initial: null }),
        properties: new fields.ArrayField(new fields.ObjectField()),
        draft: new fields.ObjectField({ required: false, nullable: true, initial: null }),
        syncState: new fields.StringField({ choices: ["pending", "synced", "failed"], initial: "synced" }),
        syncError: new fields.StringField({ required: false, blank: true, initial: "" })
      };
    }
  }
  return LegendKeeperPageModel;
}
