/** Retain a bounded prefix before a selected row; the source projection is untouched. */
export function calendarListWindow<
  Section extends { month: string; data: readonly unknown[] },
>(
  sections: readonly Section[],
  target: { sectionIndex: number; itemIndex: number },
  precedingRows: number,
): readonly Section[] {
  let sectionIndex = target.sectionIndex;
  let itemIndex = target.itemIndex - precedingRows;
  while (itemIndex < 0 && sectionIndex > 0) {
    sectionIndex -= 1;
    itemIndex += sections[sectionIndex]?.data.length ?? 0;
  }
  return sections.slice(sectionIndex).map((section, index) => ({
    ...section,
    // RN otherwise prefixes row identities with a changing section index on prepend.
    key: section.month,
    data: index === 0 ? section.data.slice(Math.max(0, itemIndex)) : section.data,
  }));
}
