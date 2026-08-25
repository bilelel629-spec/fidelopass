-- Garantit la normalisation E.164 quel que soit le point d'entree qui cree ou
-- modifie un client (API publique, import ou outil interne).

CREATE OR REPLACE FUNCTION public.set_client_telephone_e164()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  digits TEXT;
BEGIN
  digits := regexp_replace(coalesce(NEW.telephone, ''), '\D', '', 'g');

  NEW.telephone_e164 := CASE
    WHEN digits ~ '^0[67][0-9]{8}$' THEN '+33' || substr(digits, 2)
    WHEN digits ~ '^33[67][0-9]{8}$' THEN '+' || digits
    WHEN coalesce(NEW.telephone, '') LIKE '+%' AND digits ~ '^[1-9][0-9]{7,14}$' THEN '+' || digits
    ELSE NULL
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_set_telephone_e164 ON public.clients;
CREATE TRIGGER clients_set_telephone_e164
  BEFORE INSERT OR UPDATE OF telephone ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_client_telephone_e164();

UPDATE public.clients
SET telephone = telephone
WHERE telephone_e164 IS NULL
  AND telephone IS NOT NULL;
