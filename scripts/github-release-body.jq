# GitHub refuses a release body above 125000 characters. Count bytes as a
# conservative bound. Preserve complete notes in the changelog on the exact SHA.
if (.notes | utf8bytelength) <= 125000 then .notes
else "[Full release notes for \(.packageName) \(.version)](\($tree)/\(.changelog))"
end
