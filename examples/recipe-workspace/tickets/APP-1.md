# APP-1: Add a search box to the recipe list

The list shows every recipe at once. Once there are more than a screenful, there is no way
to find one by name.

Add a search box above the list on the web page. Typing in it narrows the list to the
recipes whose title matches what was typed, and clearing it shows everything again.

The matching itself belongs in the api service, next to `listRecipes`, so both the page and
a later command line client can use it.

Done when a person can type part of a title and see only the recipes that match, the match
ignores upper and lower case, and an empty box shows the whole list.
