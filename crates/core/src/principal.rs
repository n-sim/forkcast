use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// The persistent person of a standalone installation. No login.
    Local,
    /// Manages household accounts; has no access to others' personal records.
    Administrator,
    Member,
    /// A joined profile whose account signed out. Household records stay
    /// usable and attributed to the last account; personal records are hidden.
    SignedOut,
}

/// Who an operation acts for. Hosts obtain one from [`crate::Core::standalone`]
/// or [`crate::Core::authenticate`]; operations derive every household and
/// personal owner from it and never from request content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    person_id: String,
    household_id: String,
    standing: Standing,
}

impl Principal {
    pub(crate) fn new(person_id: String, household_id: String, standing: Standing) -> Self {
        Self {
            person_id,
            household_id,
            standing,
        }
    }

    pub fn person_id(&self) -> &str {
        &self.person_id
    }

    pub fn household_id(&self) -> &str {
        &self.household_id
    }

    pub fn standing(&self) -> Standing {
        self.standing
    }

    /// Server entry points authorize the household named by a request path.
    pub fn require_household(&self, id: &str) -> Result<()> {
        if id == self.household_id {
            Ok(())
        } else {
            Err(outside())
        }
    }

    /// Server entry points authorize the person named by a request path.
    pub fn require_person(&self, id: &str) -> Result<()> {
        if id == self.person_id {
            Ok(())
        } else {
            Err(outside())
        }
    }

    /// Personal records belong to a signed-in (or standalone) person.
    pub fn require_personal(&self) -> Result<()> {
        if self.standing == Standing::SignedOut {
            Err(Error::forbidden(
                "Sign in to use your personal records on this device.",
            ))
        } else {
            Ok(())
        }
    }

    pub fn is_server_account(&self) -> bool {
        matches!(self.standing, Standing::Administrator | Standing::Member)
    }

    pub fn require_administrator(&self) -> Result<()> {
        if self.standing == Standing::Administrator {
            Ok(())
        } else {
            Err(Error::forbidden(
                "Only the administrator can manage household accounts.",
            ))
        }
    }
}

pub(crate) fn outside() -> Error {
    Error::forbidden("This record is outside your account or household.")
}
