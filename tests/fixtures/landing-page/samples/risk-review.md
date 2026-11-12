# Policy verdict · quantrin-near-v1
overall         outside-policy
outside-policy  pause-operator-set
                (contract.main.burrow.near)
outside-policy  role-grantee-count-max
                (intents.near, UnrestrictedAccountLocker, 1)
within-policy   pause-state-is(intents.near, false)
undetermined    controller-resolved
                (aggregate-oracle.near) missing-coverage
policy          quantrin-near-v1
positions       local only, never sent
snapshot        near-2026-11-09
reads           get_config · acl_get_permissioned_accounts
verdict         computed offline from public facts
