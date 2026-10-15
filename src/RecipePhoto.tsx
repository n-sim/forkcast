import { useEffect, useState } from 'react';

export function RecipeCoverPhoto({
  photo,
  recipeName,
  className,
}: {
  photo: Blob;
  recipeName: string;
  className: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(photo);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  return url ? (
    <img className={className} src={url} alt={`${recipeName} cover photo`} />
  ) : null;
}

export function RecipePhotoEditor({
  photo,
  recipeName,
  onSave,
}: {
  photo?: Blob;
  recipeName: string;
  onSave: (photo: Blob | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function attach(file: File) {
    setError('');
    setMessage('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP photo.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Choose a photo smaller than 10 MB.');
      return;
    }
    setSaving(true);
    try {
      const image = await createImageBitmap(file);
      image.close();
    } catch {
      setError(
        'This photo could not be read. Choose a valid JPEG, PNG, or WebP image.',
      );
      setSaving(false);
      return;
    }
    await save(file);
  }

  async function save(photo: Blob | null) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await onSave(photo);
      setMessage(photo ? 'Cover photo saved.' : 'Cover photo removed.');
    } catch {
      setError(
        'Your cover photo could not be saved on this device. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel photo-panel" aria-labelledby="photo-heading">
      <h2 id="photo-heading">Recipe cover photo</h2>
      <p className="section-note">
        Help everyone in your household recognize this dish.
      </p>
      {photo && (
        <RecipeCoverPhoto
          photo={photo}
          recipeName={recipeName}
          className="recipe-cover"
        />
      )}
      <label htmlFor="cover-photo">Cover photo</label>
      <input
        id="cover-photo"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={saving}
        aria-describedby="photo-help"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void attach(file);
        }}
      />
      <p id="photo-help" className="section-note">
        JPEG, PNG, or WebP, up to 10 MB. Saved automatically on this device.
      </p>
      {photo && (
        <button
          className="button secondary"
          type="button"
          disabled={saving}
          onClick={() => void save(null)}
        >
          Remove cover photo
        </button>
      )}
      <p role="status" aria-label="Cover photo status">
        {saving ? 'Saving cover photo…' : message}
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </section>
  );
}
