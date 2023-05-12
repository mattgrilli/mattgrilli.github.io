document.getElementById('search-term').addEventListener('input', function() {
    const clearButton = document.getElementById('clear-search');
    const searchModal = document.getElementById('search-modal');
  
    if (this.value.trim() !== '') {
      clearButton.style.display = 'block';
      const filteredSnippets = searchSnippets(savedSnippets, this.value.trim());
      displaySearchResults(filteredSnippets, this.value.trim());
      if (filteredSnippets.length > 0) {
        searchModal.classList.remove('hidden');
      } else {
        searchModal.classList.add('hidden');
      }
    } else {
      clearButton.style.display = 'none';
      displaySnippets(savedSnippets);
      searchModal.classList.add('hidden'); 
    }
  });
  
  document.getElementById('clear-search').addEventListener('click', function() {
    document.getElementById('search-term').value = '';
    displaySnippets(savedSnippets);
    document.getElementById('search-modal').classList.add('hidden');
  
    // Clear the search results and counter
    const searchResults = document.getElementById('search-results');
    const searchCounter = document.getElementById('search-counter');
    searchResults.innerHTML = '';
    searchCounter.innerHTML = '';
  });
  
  document.getElementById('close-modal').addEventListener('click', function() {
    document.getElementById('search-modal').classList.add('hidden');
  });
  
  
  
function searchSnippets(snippets, searchTerm) {
    searchTerm = searchTerm.trim();
  
    if (searchTerm === '') {
      return [];
    }
  
    return snippets.filter(function(snippet) {
      return snippet.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        snippet.tags.toLowerCase().includes(searchTerm.toLowerCase()) ||
        snippet.code.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }
  
  function displaySearchResults(snippets, searchTerm) {
    const searchResults = document.getElementById('search-results');
    const searchCounter = document.getElementById('search-counter');
  
    // Clear the previous search results
    searchResults.innerHTML = '';
    searchCounter.innerHTML = '';
  
    // Hide the results and counter if there are no search results
    if (snippets.length === 0) {
      searchResults.style.display = 'none';
      searchCounter.style.display = 'none';
      return;
    }
  
    // Otherwise, show the results and counter
    searchResults.style.display = 'block';
    searchCounter.style.display = 'block';
  
    // Display the counter
    searchCounter.innerText = `${snippets.length} results for "${searchTerm}"`;
  
    snippets.forEach(function(snippet) {
      // Create a div for each search result
      const resultDiv = document.createElement('div');
      resultDiv.innerText = `${snippet.name}: ${snippet.desc}`;
      resultDiv.title = 'Click to view this snippet';
      resultDiv.classList.add('search-result');
      resultDiv.addEventListener('mouseover', function() {
        // Highlight the search result on mouseover
        resultDiv.classList.add('highlighted');
      });
      resultDiv.addEventListener('mouseout', function() {
        // Remove the highlight when the mouse leaves
        resultDiv.classList.remove('highlighted');
      });
      resultDiv.addEventListener('click', function() {
        // Filter the snippets list to include only the clicked snippet
        const clickedSnippet = savedSnippets.filter(function(savedSnippet) {
          return savedSnippet.name === snippet.name;
        });
        // Display only the clicked snippet
        displaySnippets(clickedSnippet);
      });
      
      searchResults.appendChild(resultDiv);
    });
  }
  